// New-tab page: render from storage.local immediately, re-render on storage changes.
// Never waits on the network. All external text goes through textContent (lib/dom.js).

import { h, s, replace } from './lib/dom.js';
import { withDefaults, DEFAULT_UI, STALE_AFTER, AV_DAILY_CAP } from './lib/config.js';
import {
  dateStr, minutesOfDay, addDays, fmtHM, fmtClock, fmtLongDate, fmtDayLabel, fmtShortDate, fmtWeekRange,
  monthName, tzAbbrev, fmtDuration, fmtHours, parseDateStr, fmtClock12, fmtWeekday, fmtDayMonth, mondayOf, daysBetween,
} from './lib/time.js';
import { describeCode, compass, precipTendency, upcomingHours, hourlySummary, isWet } from './lib/weather.js';
import {
  computeGaps, groupTodos, fillGaps, loadStats, layoutEvents, nextLabel, DAY_START, DAY_END,
} from './lib/plan.js';
import { lseState, avCallsToday } from './lib/quotes.js';

const B = globalThis.browser;
const $ = (id) => document.getElementById(id);

let store = {};

// ── formatting helpers ───────────────────────────────────────────────────

const MINUS = '−';
const signed = (n, dp = 2) => (n < 0 ? MINUS : '+') + Math.abs(n).toFixed(dp);
const deg = (n) => (n == null ? '–' : `${Math.round(n) === 0 ? 0 : Math.round(n)}`.replace('-', MINUS));
const fmtPrice = (p) => (p >= 1000 ? Math.round(p).toLocaleString('en-US') : p.toFixed(2));

function fmtUpdated(ms, now) {
  if (!ms) return '—';
  return dateStr(ms) === dateStr(now) ? fmtClock(ms) : `${fmtShortDate(dateStr(ms))} ${fmtClock(ms)}`;
}

function config() { return withDefaults(store.config); }
function ui() { return { ...DEFAULT_UI, ...(store.ui || {}) }; }

function openOptions(e) {
  if (e) e.preventDefault();
  B.runtime.openOptionsPage();
}
const optionsLink = (text = 'Options') => h('button', { type: 'button', class: 'linkbtn', onclick: openOptions }, text);

/** Third-party error text can be long: show a short version, full text on hover. */
const short = (msg, max = 110) => (msg.length > max ? `${msg.slice(0, max - 1)}…` : msg);

function panelMessage(text, { err = false, link = false } = {}) {
  return h('div', { class: `panel-msg${err ? ' err' : ''}`, title: text.length > 110 ? text : null },
    short(text), link ? [' ', optionsLink('Open Options')] : null);
}

/** Generic "not configured / loading / error-without-data" handling. Returns a node or null. */
function sourceState(rec, configured, { setup, name }) {
  if (!configured) return panelMessage(setup, { link: true });
  if (!rec || rec.data == null) {
    if (rec?.error) return panelMessage(`Couldn't load ${name}: ${rec.error}`, { err: true, link: /grant|token|not found|401|403|config/i.test(rec.error) });
    return panelMessage('Loading…');
  }
  return null;
}

// ── icons ───────────────────────────────────────────────────────────────

function wxIcon(kind) {
  const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  switch (kind) {
    case 'sun': return s('svg', { ...base, style: { stroke: 'var(--sun)' } }, s('circle', { cx: 12, cy: 12, r: 4 }),
      s('path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41' }));
    case 'partly': return s('svg', { ...base, style: { stroke: 'var(--text-2)' } },
      s('path', { d: 'M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41M15.95 12.65a4 4 0 0 0-5.93-4.61' }),
      s('path', { d: 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z' }));
    case 'moon': return s('svg', { ...base, style: { stroke: 'var(--text-2)' } }, s('path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' }));
    case 'moon-partly': return s('svg', { ...base, style: { stroke: 'var(--text-2)' } },
      s('path', { d: 'M10.1 9A6 6 0 0 1 16 4a4 4 0 0 0 6 6 6 6 0 0 1-3 5.2' }),
      s('path', { d: 'M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z' }));
    case 'rain': return s('svg', { ...base, style: { stroke: 'var(--blue)' } },
      s('path', { d: 'M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24' }), s('path', { d: 'M16 14v6M8 14v6M12 16v6' }));
    case 'snow': return s('svg', { ...base, style: { stroke: 'var(--text-2)' } },
      s('path', { d: 'M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24' }),
      s('path', { d: 'M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01' }));
    default: return s('svg', { ...base, style: { stroke: 'var(--muted)' } }, s('path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }));
  }
}

function sparkline({ values, width, height, color, stretch = false, label, xLabels }) {
  const attrs = { width: stretch ? '100%' : width, height: height + (xLabels ? 14 : 0), viewBox: `0 0 ${width} ${height + (xLabels ? 14 : 0)}`, role: 'img', 'aria-label': label };
  if (stretch) attrs.preserveAspectRatio = 'none';
  const svg = s('svg', attrs);
  if (values.length >= 2) {
    const min = Math.min(...values), max = Math.max(...values), span = (max - min) || 1;
    const pad = stretch ? 2 : 2;
    const pts = values.map((v, i) => {
      const x = stretch ? (i * width) / (values.length - 1) : (i * (width - 4)) / (values.length - 1) + 2;
      const y = height - pad - ((v - min) / span) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    svg.appendChild(s('polyline', { points: pts, fill: 'none', style: { stroke: color }, 'stroke-width': 1.5, 'vector-effect': stretch ? 'non-scaling-stroke' : null }));
  }
  if (xLabels) {
    const t = { style: { fill: 'var(--muted)' }, 'font-size': 9, 'font-family': 'ui-monospace, Menlo, monospace', y: height + 12 };
    svg.appendChild(s('text', { ...t, x: 0 }, xLabels[0]));
    svg.appendChild(s('text', { ...t, x: width, 'text-anchor': 'end' }, xLabels[1]));
  }
  return svg;
}

// ── header ──────────────────────────────────────────────────────────────

function renderHeader(now) {
  $('date').textContent = fmtLongDate(dateStr(now));
  $('clock').textContent = fmtClock12(now);
  $('tz').textContent = tzAbbrev(now);
  // Singapore time, with its weekday when it's already a different day there.
  const SG = 'Asia/Singapore';
  const sgDay = dateStr(now, SG) !== dateStr(now) ? `${fmtWeekday(now, SG)} ` : '';
  $('clock-sg').textContent = `${sgDay}${fmtClock12(now, SG)}`;

  const w = store.weather?.data;
  if (w) {
    $('hdr-weather').textContent = `Philadelphia · ${deg(w.current.temp)}°C ${describeCode(w.current.code).text}`;
  } else {
    $('hdr-weather').textContent = 'Philadelphia';
  }

  const c = config();
  const parts = [];
  if (c.calendars.length && store.calendar?.data) {
    const n = store.calendar.data.events.filter((e) => e.date === dateStr(now)).length;
    parts.push(`${n} event${n === 1 ? '' : 's'}`);
  }
  if (c.notionToken && store.notion?.data) {
    const n = store.notion.data.todos.length;
    parts.push(`${n} open to-do${n === 1 ? '' : 's'}`);
  }
  $('hdr-counts').textContent = parts.join(' · ');

  applyTheme(ui().theme);
  const priv = ui().privacy;
  document.body.classList.toggle('privacy', priv);
  $('privacy').setAttribute('aria-pressed', String(priv));
}

function applyTheme(theme) {
  const light = theme === 'light';
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  const btn = $('theme');
  btn.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  btn.title = light ? 'Dark mode' : 'Light mode';
  try { localStorage.setItem('theme', light ? 'light' : 'dark'); } catch { /* ignore */ }
}

function renderBanner() {
  const c = config();
  const nothing = !c.calendars.length && !c.notionToken && !c.alphaVantageKey;
  const el = $('banner');
  el.hidden = !nothing;
  if (nothing) {
    replace(el,
      h('strong', null, 'Welcome!'),
      h('span', { class: 'muted' }, 'Weather works out of the box. Add your Google Calendar iCal addresses, Notion token and Alpha Vantage key to fill in the rest.'),
      optionsLink('Open Options →'));
  }
}

// ── markets ─────────────────────────────────────────────────────────────

function renderVwra(now) {
  const el = $('vwra');
  const c = config();
  const head = (meta) => h('div', { class: 'vwra-row' },
    h('span', { class: 'vwra-sym' }, 'VWRA'),
    h('span', { class: 'xs muted' }, meta));
  if (!c.alphaVantageKey) {
    return replace(el, h('div', { class: 'vwra-main' }, head('LSE · USD'),
      h('span', { class: 'xs muted' }, 'Add an Alpha Vantage key in ', optionsLink(), '.')));
  }
  const q = store.quotes?.data?.vwra;
  const err = store.quotes?.sources?.alphaVantage?.error;
  if (!q) {
    return replace(el, h('div', { class: 'vwra-main' }, head('LSE · USD'),
      h('span', { class: `xs ${err ? 'amber' : 'muted'}`, title: err || null }, err ? `Couldn't load: ${short(err, 70)}` : 'Loading…')));
  }
  const st = lseState(now);
  const live = q.day === st.date && st.open;
  const when = live ? `live · ${fmtUpdated(store.quotes.sources.alphaVantage?.fetchedAt, now)}` : `${fmtShortDate(q.day)} close`;
  const up = (q.change ?? 0) >= 0;

  const hist = (store.vwraHistory?.data || []).map((r) => r.close);
  const histRows = store.vwraHistory?.data || [];
  const last50 = hist.slice(-50), last30 = histRows.slice(-30);
  const avg50 = last50.length >= 10 ? last50.reduce((a, b) => a + b, 0) / last50.length : null;
  const closes30 = last30.map((r) => r.close);
  const statsLine = [];
  if (avg50 != null) {
    const d = (q.price / avg50 - 1) * 100;
    statsLine.push(`${last50.length >= 50 ? '50' : last50.length}-day avg ${avg50.toFixed(2)} `,
      h('span', { class: d >= 0 ? 'up' : 'down' }, `(${signed(d, 1)}%)`));
  }
  if (closes30.length >= 2) {
    statsLine.push(` · 30-day range ${Math.min(...closes30).toFixed(2)}–${Math.max(...closes30).toFixed(2)}`);
  }
  if (!statsLine.length) statsLine.push('Building local history…');

  replace(el,
    h('div', { class: 'vwra-main' },
      head(`LSE · USD · ${when}`),
      h('div', { class: 'vwra-row', style: { gap: '10px' } },
        h('span', { class: 'vwra-price' }, q.price.toFixed(2)),
        q.changePct != null
          ? h('span', { class: `vwra-ch ${up ? 'up' : 'down'}` }, `${up ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}% (${signed(q.change ?? 0)})`)
          : null),
      h('span', { class: 'xs muted' }, statsLine)),
    closes30.length >= 2
      ? sparkline({
        values: closes30, width: 210, height: 44, color: 'var(--muted)',
        label: 'VWRA closing prices, last 30 trading days',
        xLabels: [fmtShortDate(last30[0].date), fmtShortDate(last30[last30.length - 1].date)],
      })
      : null);
}

function renderHourly(now) {
  const el = $('hourly');
  const rec = store.weather;
  const blocked = sourceState(rec, true, { name: 'the hourly forecast', setup: '' });
  const nowHour = `${dateStr(now)}T${fmtHM(minutesOfDay(now)).slice(0, 2)}:00`;
  const hours = blocked ? [] : upcomingHours(rec.data.hours, nowHour, 24);
  if (blocked || !hours.length) {
    return replace(el, blocked || panelMessage(rec.data.hours ? 'No hourly forecast cached — refreshing…' : 'Loading the hourly forecast…'));
  }
  const msg = hourlySummary(hours, (d) => fmtDayLabel(d).split(' ')[0]);
  const temps = hours.map((x) => x.temp);
  const stale = !!rec.error || now - (rec.fetchedAt || 0) > STALE_AFTER.weather;
  // Re-rendered every minute: keep where the user scrolled to (shifted when the hour rolls over).
  const prev = el.querySelector('.hours');
  const prevFirst = prev?.dataset.first;
  const keep = prev ? prev.scrollLeft - (prevFirst && prevFirst !== hours[0].time ? (prev.firstElementChild?.offsetWidth || 0) : 0) : 0;
  replace(el,
    h('div', { class: 'hr-sum' },
      h('span', { class: 'hr-title' }, `NEXT ${hours.length} H`),
      h('span', { class: `hr-msg${/^Dry/.test(msg) ? '' : ' wet'}` }, msg),
      h('span', { class: 'xs muted' }, `${deg(Math.min(...temps))}° to ${deg(Math.max(...temps))}°C`),
      stale ? h('span', { class: 'xs amber', title: rec.error || null }, `as of ${fmtUpdated(rec.fetchedAt, now)}`) : null),
    h('ol', { class: 'hours', 'data-first': hours[0].time, tabindex: '0', 'aria-label': 'Hourly forecast' }, hours.map((x, i) => {
      const hh = x.time.slice(11, 13);
      const midnight = hh === '00' && i > 0;
      const d = describeCode(x.code);
      const kind = x.day ? d.kind : (d.kind === 'sun' ? 'moon' : d.kind === 'partly' ? 'moon-partly' : d.kind);
      const pop = x.pop ?? 0;
      return h('li', {
        class: [i === 0 ? 'cur' : '', midnight ? 'midnight' : '', isWet(x) ? 'wet' : ''].filter(Boolean).join(' ') || null,
        title: `${x.time.slice(11, 16)} · ${d.text}${x.pop != null ? ` · ${pop}% chance of rain` : ''}${x.precip ? ` · ${x.precip.toFixed(1)} mm` : ''}`,
      },
      h('span', { class: 't' }, i === 0 ? 'Now' : midnight ? fmtDayLabel(x.time.slice(0, 10)).split(' ')[0] : hh),
      h('span', { class: 'ic' }, wxIcon(kind)),
      h('span', { class: 'v' }, `${deg(x.temp)}°`),
      h('span', { class: 'p' }, pop >= 20 ? `${Math.round(pop / 10) * 10}%` : ''));
    })));
  if (keep > 0) el.querySelector('.hours').scrollLeft = keep;
}

// ── schedule ────────────────────────────────────────────────────────────

const HOUR_PX = 44;
const y = (min) => ((min - DAY_START) / 60) * HOUR_PX;

function scheduleModel(now) {
  const today = dateStr(now);
  const nowMin = minutesOfDay(now);
  const events = store.calendar?.data?.events || [];
  const todos = config().notionToken ? store.notion?.data?.todos || [] : [];
  const todayEvents = events.filter((e) => e.date === today);
  const { groups, later } = groupTodos(todos, todayEvents, today, nowMin);
  const gaps = computeGaps(todayEvents, today, nowMin);
  const { gaps: filled, placements } = fillGaps(gaps, groups);
  return { today, nowMin, events, todayEvents, groups, later, gaps: filled, placements, stats: loadStats(groups, gaps) };
}

// Day shown in the schedule, as an offset from today. null = automatic (tomorrow from 18:00).
let schedOffset = null;

function hasCalendars() { return config().calendars.length > 0; }

/** The calendar data's date range (older cached data stored `days` instead). */
function calendarRange(data, today) {
  if (!data) return { from: today, to: today };
  if (data.from && data.to) return { from: data.from, to: data.to };
  const days = data.days || [today];
  return { from: days[0], to: days[days.length - 1] };
}

function scheduleDate(model) {
  const auto = model.nowMin >= 18 * 60 ? 1 : 0;
  return addDays(model.today, schedOffset ?? auto);
}

function shiftDay(delta) {
  const now = Date.now();
  const today = dateStr(now);
  const model = { today, nowMin: minutesOfDay(now) };
  const { from, to } = calendarRange(store.calendar?.data, today);
  const next = addDays(scheduleDate(model), delta);
  if (next < from || next > to) return;
  schedOffset = daysBetween(today, next);
  render();
}

function goToday() {
  schedOffset = 0;
  render();
}

function renderSchedule(now, model) {
  const body = $('sched-body');
  const rec = store.calendar;
  const blocked = sourceState(rec, hasCalendars(), {
    name: 'calendar', setup: 'Connect Google Calendar: paste your calendars’ secret iCal addresses in Options.',
  });
  const nav = $('day-nav');
  const setNext = (text) => { $('sched-next').textContent = text; $('sched-next').hidden = !text; };
  if (blocked) {
    $('sched-title').textContent = 'Schedule';
    nav.hidden = true;
    setNext('');
    return replace(body, blocked);
  }

  const today = model.today;
  const date = scheduleDate(model);
  const diff = daysBetween(today, date);
  // Short title so the day buttons stay on the same line; the full date goes in the line below.
  const rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : fmtDayMonth(date);
  const dateNote = diff === 1 || diff === -1 ? `${fmtDayMonth(date)} · ` : '';
  $('sched-title').textContent = `Schedule · ${rel}`;
  $('sched-title').title = fmtDayMonth(date);

  const { from, to } = calendarRange(rec.data, today);
  nav.hidden = false;
  $('day-prev').disabled = date <= from;
  $('day-next').disabled = date >= to;
  $('day-today').disabled = diff === 0;

  const calendars = rec.data.calendars || [];
  const multi = calendars.length > 1;
  const calOf = (e) => (e.cal != null ? calendars[e.cal] : null);

  const dayEvents = model.events.filter((e) => e.date === date);
  const allDay = dayEvents.filter((e) => e.allDay);
  const timed = dayEvents.filter((e) => !e.allDay);
  const inGrid = timed.filter((e) => e.endMin > DAY_START && e.startMin < DAY_END);
  const before = timed.filter((e) => e.endMin <= DAY_START);
  const after = timed.filter((e) => e.startMin >= DAY_END);

  let gaps = [];
  if (diff === 0) {
    gaps = model.gaps;
    setNext(nextLabel(model.todayEvents, date, model.nowMin) || (dayEvents.length ? '' : 'No events today'));
  } else if (diff > 0) {
    gaps = computeGaps(dayEvents, date, 0).map((g) => ({ ...g, suggestions: [] }));
    const free = gaps.reduce((sum, g) => sum + g.minutes, 0);
    const count = `${dayEvents.length || 'No'} event${dayEvents.length === 1 ? '' : 's'}`;
    let tonight = '';
    if (diff === 1 && schedOffset == null) {
      const left = model.todayEvents.filter((e) => !e.allDay && e.endMin > model.nowMin);
      tonight = left.length ? ` · Tonight: ${left.map((e) => `${e.title} ${fmtHM(e.startMin)}`).join(', ')}` : '';
    }
    setNext(`${dateNote}${count} · ${fmtHours(free)} free 08–20${tonight}`);
  } else {
    setNext(`${dateNote}${dayEvents.length || 'No'} event${dayEvents.length === 1 ? '' : 's'}`);
  }

  const grid = h('div', { class: 'grid' });
  for (let hr = DAY_START / 60; hr <= DAY_END / 60; hr++) {
    grid.appendChild(h('div', { class: 'hour', style: { top: `${y(hr * 60)}px` } },
      h('span', null, `${String(hr).padStart(2, '0')}:00`), h('span')));
  }
  for (const g of gaps) {
    const top = y(g.start) + 2, height = y(g.end) - y(g.start) - 4;
    if (height < 8) continue;
    const tight = height < 34;
    const fits = g.suggestions.map((sg) => {
      const extra = sg.kind === 'overdue' ? ' · overdue' : '';
      return h('span', { class: 'fit' }, `→ ${sg.todo.title} (${fmtDuration(sg.todo.estimate)})${extra}`);
    });
    grid.appendChild(h('div', {
      class: `gap${tight ? ' tight' : ''}`,
      style: { top: `${top}px`, height: `${height}px`, left: '52px', right: '4px' },
    }, h('span', { class: 'free' }, `${fmtDuration(g.end - g.start)} free`), tight ? fits.slice(0, 1) : fits));
  }
  for (const e of layoutEvents(inGrid)) {
    const s0 = Math.max(e.startMin, DAY_START), e0 = Math.min(Math.max(e.endMin, e.startMin + 15), DAY_END);
    const top = y(s0) + 1, height = Math.max(14, y(e0) - y(s0) - 2);
    const w = `(100% - 56px) / ${e.cols}`;
    const past = diff < 0 || (diff === 0 && e.endMin <= model.nowMin);
    const range = `${fmtHM(e.startMin)}–${fmtHM(e.endMin)}`;
    const cal = calOf(e);
    const tall = height >= 36;
    grid.appendChild(h('div', {
      class: `event ${e.kind}${e.cols > 1 || tall ? ' narrow' : ''}${past ? ' past' : ''}`,
      style: {
        top: `${top}px`, height: `${height}px`,
        left: `calc(52px + ${w} * ${e.col})`, width: `calc(${w} - 2px)`,
        'box-shadow': multi && cal ? `inset 3px 0 0 ${cal.color}` : null,
      },
      title: `${e.title}\n${range}${e.meta ? ' · ' + e.meta : ''}${cal && multi ? `\n${cal.name}` : ''}`,
    },
    h('span', { class: 't' }, e.title),
    h('span', { class: 'm' }, e.meta ? `${range} · ${e.meta}` : range)));
  }
  if (diff === 0 && model.nowMin >= DAY_START && model.nowMin <= DAY_END) {
    grid.appendChild(h('div', { class: 'now', style: { top: `${y(model.nowMin) - 4}px` } }, h('span'), h('span')));
  }

  const line = (label, list) => (list.length
    ? h('div', { class: 'extra-line' }, `${label}: ${list.map((e) => `${fmtHM(e.startMin)} ${e.title}`).join(' · ')}`)
    : null);
  const legend = multi
    ? h('div', { class: 'cal-legend' }, calendars.map((c) => h('span', { title: c.error ? `Last error: ${c.error}` : null, class: c.error ? 'stale' : null },
      h('span', { class: 'sw', style: { background: c.color } }), c.name)))
    : null;
  replace(body,
    h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } },
      allDay.length ? h('div', { class: 'allday' }, allDay.map((e) => {
        const cal = calOf(e);
        return h('span', {
          title: cal && multi ? `${e.title}\n${cal.name}` : e.title,
          style: { 'box-shadow': multi && cal ? `inset 3px 0 0 ${cal.color}` : null },
        }, e.title);
      })) : null,
      line('Before 08:00', before),
      grid,
      line('After 20:00', after),
      legend));
}

// ── weather ─────────────────────────────────────────────────────────────

function anomalyBar(d) {
  const cold = 'var(--blue)', warm = 'var(--orange)', flat = 'var(--text-2)';
  if (d == null) return { style: { left: '48.5%', width: '3%' }, color: flat, text: '–' };
  const w = Math.min((Math.abs(d) / 3) * 50, 50);
  if (Math.abs(d) < 0.25) return { style: { left: '48.5%', width: '3%' }, color: flat, text: '±0°' };
  return d < 0
    ? { style: { right: '50%', width: `${w.toFixed(1)}%` }, color: cold, text: `${MINUS}${Math.abs(d).toFixed(1)}°` }
    : { style: { left: '50%', width: `${w.toFixed(1)}%` }, color: warm, text: `+${d.toFixed(1)}°` };
}

function renderWeather(now) {
  const body = $('weather-body');
  const view = ui().weatherView === 'month' ? 'month' : 'days';
  $('view-days').setAttribute('aria-pressed', String(view === 'days'));
  $('view-month').setAttribute('aria-pressed', String(view === 'month'));

  const rec = store.weather;
  const nodes = [];
  const blocked = sourceState(rec, true, { name: 'weather', setup: '' });
  const today = dateStr(now);
  if (blocked) {
    nodes.push(blocked);
  } else {
    const { current, days } = rec.data;
    const d0 = days.find((d) => d.date === today) || days[0];
    const desc = describeCode(current.code).text;
    nodes.push(h('div', { class: 'wx-now' },
      h('span', { class: 'wx-temp' }, `${deg(current.temp)}°`),
      h('div', { class: 'wx-facts' },
        h('span', null, desc.charAt(0).toUpperCase() + desc.slice(1)),
        h('span', null, `Feels ${deg(current.feels)}°`),
        h('span', null, `H ${deg(d0.hi)}° · L ${deg(d0.lo)}°`),
        h('span', null, `Rain ${d0.pop ?? '–'}%`),
        h('span', null, `Wind ${current.wind == null ? '–' : Math.round(current.wind)} km/h ${compass(current.windDir)}`),
        h('span', null, d0.sunset ? `Sunset ${d0.sunset}` : ''))));
    if (view === 'days') {
      const list = days.filter((d) => d.date >= today).slice(0, 16);
      const lo0 = Math.min(...list.map((d) => d.lo)), hi0 = Math.max(...list.map((d) => d.hi));
      const span = (hi0 - lo0) || 1;
      nodes.push(h('div', { class: 'wx-list' },
        h('h3', null, `NEXT ${list.length} DAYS · °C`),
        list.map((d, i) => h('div', { class: 'wx-day' },
          h('span', { style: { color: i === 0 ? 'var(--text)' : 'var(--muted)' } }, i === 0 ? 'Today' : fmtDayLabel(d.date)),
          h('span', { class: 'icon', title: describeCode(d.code).text }, wxIcon(describeCode(d.code).kind)),
          h('span', { class: 'lo' }, deg(d.lo)),
          h('span', { class: 'bar' }, h('span', {
            class: 'fill',
            style: { background: 'var(--bar)', left: `${(((d.lo - lo0) / span) * 100).toFixed(1)}%`, width: `${Math.max(2, ((d.hi - d.lo) / span) * 100).toFixed(1)}%` },
          })),
          h('span', null, deg(d.hi))))));
    }
  }
  if (view === 'month') nodes.push(renderOutlook(today));
  replace(body, h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '14px' } }, nodes));
}

/** Background tint for a weekly temperature anomaly (warm orange / cold blue). */
function anomalyTint(d) {
  if (d == null || Math.abs(d) < 0.25) return null;
  const a = (0.08 + 0.22 * Math.min(Math.abs(d) / 3, 1)).toFixed(2);
  const pct = Math.round(a * 100);
  return `color-mix(in srgb, var(${d > 0 ? '--orange' : '--blue'}) ${pct}%, transparent)`;
}

/**
 * Monthly view as a calendar: Mon–Sun rows for six weeks from this week. Days inside the
 * 16-day forecast show their icon and high/low; later days are tinted by that week's
 * EC46 anomaly. The last column summarises each week; season cards follow.
 */
function renderOutlook(today) {
  const rec = store.weatherOutlook;
  const forecast = new Map((store.weather?.data?.days || []).map((d) => [d.date, d]));
  const weeksByStart = new Map((rec?.data?.weeks || []).map((w) => [w.start, w]));
  const first = mondayOf(today);
  const rows = Array.from({ length: 6 }, (_, i) => addDays(first, i * 7));
  const lastForecast = [...forecast.keys()].sort().pop() || today;

  const head = h('div', { class: 'wx-cal-head' },
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('span', null, d)),
    h('span', { class: 'r' }, 'vs usual'));

  const cells = [];
  rows.forEach((start, ri) => {
    const week = weeksByStart.get(start);
    const tint = anomalyTint(week?.anomaly);
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const p = parseDateStr(d);
      const label = p.day === 1 || (ri === 0 && i === 0) ? fmtShortDate(d) : String(p.day);
      const fc = forecast.get(d);
      const past = d < today;
      const outlook = !fc && d > lastForecast;
      const desc = fc ? describeCode(fc.code) : null;
      cells.push(h('div', {
        class: `wx-cell${d === today ? ' today' : ''}${past ? ' past' : ''}`,
        style: { background: outlook && tint ? tint : null },
        title: fc
          ? `${fmtDayMonth(d)} · ${desc.text} · ${deg(fc.lo)}° to ${deg(fc.hi)}°${fc.pop != null ? ` · rain ${fc.pop}%` : ''}`
          : outlook && week ? `${fmtDayMonth(d)} · week ${anomalyBar(week.anomaly).text} vs usual` : fmtDayMonth(d),
      },
      h('span', { class: 'n' }, label),
      fc && !past ? [
        h('span', { class: 'row' }, h('span', { class: 'ic' }, wxIcon(desc.kind)), h('span', { class: 't' }, `${deg(fc.hi)}°`)),
        h('span', { class: 'lo' }, `${deg(fc.lo)}°`),
      ] : null));
    }
    const a = week ? anomalyBar(week.anomaly) : null;
    // The current week is partly in the past, so its rain total isn't comparable.
    const rain = week && start > today ? precipTendency(week.precip, week.precipAnomaly) : null;
    cells.push(h('div', { class: 'wx-cell sum', title: week ? `${fmtWeekRange(start)}: avg ${deg(week.hi)}° / ${deg(week.lo)}°, ${a.text} vs usual, ${rain || '–'}` : null },
      a ? h('span', { style: { color: a.color } }, a.text) : h('span', { class: 'muted' }, '–'),
      week ? h('span', { class: 'muted' }, `${deg(week.hi)}°/${deg(week.lo)}°`) : null,
      rain ? h('span', { class: 'muted' }, rain) : null));
  });

  const curMonth = today.slice(0, 7);
  const months = (rec?.data?.months || []).filter((m) => m.start.slice(0, 7) > curMonth).slice(0, 3);
  const blocked = sourceState(rec, true, { name: 'the seasonal outlook', setup: '' });
  return h('div', { class: 'wx-month' },
    h('h3', null, 'NEXT 6 WEEKS · DAILY FORECAST, THEN WEEKLY TREND'),
    h('div', { class: 'wx-cal' }, head, cells),
    h('div', { class: 'wx-key' },
      h('span', null, h('span', { class: 'sw', style: { background: 'color-mix(in srgb, var(--orange) 30%, transparent)' } }), 'warmer than usual'),
      h('span', null, h('span', { class: 'sw', style: { background: 'color-mix(in srgb, var(--blue) 30%, transparent)' } }), 'colder than usual'),
      h('span', null, 'shaded days are trends, not forecasts')),
    blocked,
    months.length ? h('h3', { style: { margin: '12px 0 4px' } }, 'SEASON · VS USUAL') : null,
    months.length ? h('div', { class: 'wx-months' }, months.map((m) => {
      const a = anomalyBar(m.anomaly);
      const t = precipTendency(m.precip, m.precipAnomaly);
      return h('div', null,
        h('span', { class: 'xs muted' }, monthName(m.start)),
        h('span', { style: { 'font-size': '16px', color: a.color } }, a.text),
        h('span', { class: 'xs muted' }, t === 'normal' ? 'Rain normal' : t ? t.charAt(0).toUpperCase() + t.slice(1) : '–'));
    })) : null,
    h('span', { class: 'wx-note' }, 'Trends, not daily forecasts: ECMWF 46-day and seasonal outlooks via Open-Meteo.'));
}

// ── to-dos ──────────────────────────────────────────────────────────────

/** High priority → red ring, medium → amber ring; others stay neutral. */
function prioClass(t) {
  const r = t.priority?.rank;
  if (r == null) return '';
  return r <= 1 ? ' p-high' : r === 2 ? ' p-med' : '';
}

function renderTodos(now, model) {
  const body = $('todo-body');
  const statsEl = $('todo-stats');
  const c = config();
  const rec = store.notion;
  $('todo-meta').textContent = rec?.fetchedAt ? `Notion · ${fmtUpdated(rec.fetchedAt, now)}` : 'Notion';
  const blocked = sourceState(rec, !!(c.notionToken && c.notionDatabase), {
    name: 'to-dos', setup: 'Connect Notion: add your integration token and to-do database in Options.',
  });
  if (blocked) {
    statsEl.hidden = true;
    return replace(body, blocked);
  }
  statsEl.hidden = false;
  const { groups, later, placements } = model;
  const RED = 'var(--down)', BLUE = 'var(--blue)', MUTED = 'var(--muted)';
  const groupColor = { overdue: RED, prep: BLUE, today: MUTED, week: MUTED };

  const item = (t, kind) => {
    let meta, metaColor = MUTED;
    if (kind === 'overdue') { meta = t.due ? fmtDayLabel(t.due) : 'overdue'; metaColor = RED; }
    else if (kind === 'week') meta = t.due ? fmtDayLabel(t.due) : '';
    else if (kind === 'later') meta = t.due ? fmtShortDate(t.due) : (t.estimate ? fmtDuration(t.estimate) : '');
    else meta = t.estimate ? fmtDuration(t.estimate) : 'no est.';
    if (kind === 'overdue' && t.estimate) meta = `${meta} · ${fmtDuration(t.estimate)}`;
    const placed = placements.get(t.id);
    const tag = t.url ? 'a' : 'div';
    return h(tag, {
      class: 'todo',
      href: t.url || null, target: t.url ? '_blank' : null, rel: t.url ? 'noopener noreferrer' : null,
      title: [t.title, t.priority ? `Priority: ${t.priority.label}` : null, t.related ? `Related: ${t.related}` : null].filter(Boolean).join('\n'),
    },
    h('span', { class: `dot${prioClass(t)}`, 'aria-hidden': 'true' }),
    h('span', { class: 'body' },
      h('span', { class: 'title' }, t.title),
      placed != null ? h('span', { class: 'note' }, `Fits ${fmtHM(placed)} gap`) : null),
    meta ? h('span', { class: 'meta', style: { color: metaColor } }, meta) : h('span'));
  };

  const nodes = groups.map((g) => h('div', { class: 'todo-group' },
    h('h3', { style: { color: groupColor[g.kind] } }, `${g.name} · ${g.items.length}`),
    g.items.map((t) => item(t, g.kind))));
  if (!groups.length) {
    nodes.push(panelMessage(later.length ? 'Nothing due this week.' : 'No open to-dos. 🎉'));
  }
  if (later.length) {
    nodes.push(h('div', { class: 'todo-group' },
      h('h3', { style: { color: MUTED } }, `Later / no date · ${later.length}`),
      later.slice(0, 5).map((t) => item(t, 'later')),
      later.length > 5 ? h('span', { class: 'todo-later' }, `+${later.length - 5} more in Notion`) : null));
  }
  replace(body, h('div', { class: 'todo-groups' }, nodes));

  const st = model.stats;
  const noCal = !c.calendars.length;
  replace(statsEl,
    h('div', null, h('span', { class: 'v' }, fmtHours(st.due)), h('span', { class: 'k' }, 'tasks due today')),
    h('div', null, h('span', { class: 'v' }, fmtHours(st.free)), h('span', { class: 'k' }, noCal ? 'free until 20:00' : 'free between events')),
    h('div', null,
      h('span', { class: 'v', style: { color: st.fits ? 'var(--up)' : (st.over > 60 ? 'var(--down)' : 'var(--amber)') } },
        st.fits ? 'Fits' : `Over by ${fmtHours(st.over)}`),
      h('span', { class: 'k' }, "today's load")));
}

// ── footer ──────────────────────────────────────────────────────────────

function renderFooter(now) {
  const c = config();
  const items = [];
  const item = (label, { at, error, staleAfter, extra = '' }) => {
    const stale = !!error || !at || now - at > staleAfter;
    items.push(h('span', { class: stale ? 'stale' : null, title: error ? `Last error: ${error}` : (stale ? 'Data is stale' : null) },
      `● ${label} ${fmtUpdated(at, now)}${extra}${error ? ' · error' : ''}`));
  };
  if (c.calendars.length) {
    const cals = store.calendar?.data?.calendars || [];
    const failed = cals.filter((x) => x.error);
    item(cals.length > 1 ? `Google Calendar (${cals.length})` : 'Google Calendar', {
      at: store.calendar?.fetchedAt,
      error: store.calendar?.error || (failed.length ? failed.map((x) => `${x.name}: ${x.error}`).join('; ') : null),
      staleAfter: STALE_AFTER.calendar,
    });
  }
  if (c.notionToken) item('Notion', { at: store.notion?.fetchedAt, error: store.notion?.error, staleAfter: STALE_AFTER.notion });
  item('Open-Meteo', {
    at: store.weather?.fetchedAt,
    error: store.weather?.error || store.weatherOutlook?.error,
    staleAfter: STALE_AFTER.weather,
  });
  if (c.alphaVantageKey) {
    const av = store.quotes?.sources?.alphaVantage || {};
    const calls = avCallsToday(store.avBudget, now);
    item('Alpha Vantage', {
      at: av.fetchedAt, error: av.error || store.vwraHistory?.error, staleAfter: STALE_AFTER.alphaVantage,
      extra: ` · VWRA · ${calls} of 25 daily calls${calls >= AV_DAILY_CAP ? ' (budget reached)' : ''} · history cached locally`,
    });
  }
  replace($('status'), items);
}

// ── main ────────────────────────────────────────────────────────────────

function safe(fn, ...args) {
  try { fn(...args); } catch (e) { console.error(fn.name, e); }
}

function render() {
  const now = Date.now();
  let model;
  try { model = scheduleModel(now); } catch (e) { console.error(e); model = null; }
  safe(renderBanner);
  safe(renderHeader, now);
  safe(renderHourly, now);
  safe(renderVwra, now);
  if (model) {
    safe(renderSchedule, now, model);
    safe(renderTodos, now, model);
  }
  safe(renderWeather, now);
  safe(renderFooter, now);
}

async function setUi(patch) {
  const next = { ...ui(), ...patch };
  store.ui = next;
  render();
  await B.storage.local.set({ ui: next });
}

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function scheduleMinuteTick() {
  const now = Date.now();
  setTimeout(() => { render(); scheduleMinuteTick(); }, 60000 - (now % 60000) + 50);
}

async function init() {
  store = await B.storage.local.get(null);
  render();

  B.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (newValue === undefined) delete store[k]; else store[k] = newValue;
    }
    render();
  });

  $('privacy').addEventListener('click', () => setUi({ privacy: !ui().privacy }));
  $('settings').addEventListener('click', () => openOptions());
  $('theme').addEventListener('click', () => setUi({ theme: ui().theme === 'light' ? 'dark' : 'light' }));
  $('view-days').addEventListener('click', () => setUi({ weatherView: 'days' }));
  $('view-month').addEventListener('click', () => setUi({ weatherView: 'month' }));
  $('day-prev').addEventListener('click', () => shiftDay(-1));
  $('day-next').addEventListener('click', () => shiftDay(1));
  $('day-today').addEventListener('click', goToday);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    if ((e.key === 'p' || e.key === 'P') && !e.repeat) {
      e.preventDefault();
      setUi({ privacy: !ui().privacy });
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('.hours')) {
      // ←/→ step through days in the schedule (not while scrolling the hourly strip).
      if (!hasCalendars() || !store.calendar?.data) return;
      e.preventDefault();
      shiftDay(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      render();
      B.runtime.sendMessage({ type: 'tick' }).catch(() => {});
    }
  });

  scheduleMinuteTick();
  // Ask the background page to catch up (it only fetches what is due; never blocks rendering).
  B.runtime.sendMessage({ type: 'tick' }).catch(() => {});
}

init();
