// Options: enter/edit keys and settings (storage.local only — never storage.sync).

import { h, replace } from './lib/dom.js';
import { withDefaults, DEFAULT_CONFIG, AV_DAILY_CAP, MAX_CALENDARS, CALENDAR_COLORS } from './lib/config.js';
import { isValidIcalUrl } from './lib/calendar.js';
import { parseNotionId } from './lib/notion.js';
import { avCallsToday } from './lib/quotes.js';
import { dateStr, fmtClock, fmtShortDate } from './lib/time.js';

const B = globalThis.browser;
const $ = (id) => document.getElementById(id);
const PROP_KEYS = Object.keys(DEFAULT_CONFIG.notionProps);
const ORIGINS = B.runtime.getManifest().host_permissions;

function setMsg(text, kind = '') {
  const el = $('msg');
  el.textContent = text;
  el.className = kind;
}

// ── calendar rows ──

function calRow(cal = { url: '', name: '' }) {
  const url = h('input', {
    type: 'password', class: 'cal-url', spellcheck: 'false', 'aria-label': 'Secret iCal address',
    placeholder: 'https://calendar.google.com/calendar/ical/…/private-…/basic.ics',
  });
  url.value = cal.url;
  const name = h('input', { type: 'text', class: 'cal-name', spellcheck: 'false', placeholder: 'Name (optional)', 'aria-label': 'Calendar name' });
  name.value = cal.name || '';
  const reveal = h('button', { type: 'button' }, 'Show');
  reveal.addEventListener('click', () => {
    const show = url.type === 'password';
    url.type = show ? 'text' : 'password';
    reveal.textContent = show ? 'Hide' : 'Show';
  });
  const row = h('div', { class: 'cal-row' }, h('span', { class: 'swatch' }), name, url, reveal);
  const remove = h('button', { type: 'button', 'aria-label': 'Remove calendar' }, 'Remove');
  remove.addEventListener('click', () => { row.remove(); renumberCals(); });
  row.appendChild(remove);
  return row;
}

function renumberCals() {
  const rows = [...document.querySelectorAll('.cal-row')];
  rows.forEach((r, i) => { r.querySelector('.swatch').style.background = CALENDAR_COLORS[i % CALENDAR_COLORS.length]; });
  $('add-cal').disabled = rows.length >= MAX_CALENDARS;
}

function readCals() {
  return [...document.querySelectorAll('.cal-row')].map((r) => ({
    url: r.querySelector('.cal-url').value.trim(),
    name: r.querySelector('.cal-name').value.trim().slice(0, 60),
    row: r,
  }));
}

async function load() {
  const { config } = await B.storage.local.get('config');
  const c = withDefaults(config);
  replace($('cal-list'), (c.calendars.length ? c.calendars : [{ url: '', name: '' }]).map(calRow));
  renumberCals();
  $('notionToken').value = c.notionToken;
  $('notionDatabase').value = c.notionDatabase;
  for (const k of PROP_KEYS) $(`prop-${k}`).value = c.notionProps[k];
  $('alphaVantageKey').value = c.alphaVantageKey;
}

let notionMeta = null;

/** The configured Status property's options in the database (known after the first fetch). */
function statusOptions() {
  const name = $('prop-status').value.trim() || DEFAULT_CONFIG.notionProps.status;
  return notionMeta?.propOptions?.[name] || null;
}

const doneList = () => $('prop-doneValues').value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);

function renderStatusHint() {
  const el = $('status-options');
  const opts = statusOptions();
  if (!opts) {
    el.textContent = '';
    return;
  }
  const done = new Set(doneList());
  const hidesAll = opts.length > 0 && opts.every((o) => done.has(o.toLowerCase()));
  el.className = `hint${hidesAll ? ' warn' : ''}`;
  el.textContent = hidesAll
    ? `This hides every to-do. Your options are: ${opts.join(', ')} — list only the finished one(s), e.g. "${opts[opts.length - 1]}".`
    : `Options in your database: ${opts.join(', ')}`;
}

function validate() {
  const errors = [];
  const mark = (id, bad, msg) => {
    $(id).classList.toggle('invalid', bad);
    if (bad) errors.push(msg);
  };
  const seenUrls = new Set();
  for (const [i, c] of readCals().entries()) {
    const input = c.row.querySelector('.cal-url');
    const bad = c.url !== '' && (!isValidIcalUrl(c.url) || seenUrls.has(c.url));
    input.classList.toggle('invalid', bad);
    if (bad) errors.push(seenUrls.has(c.url) ? `Calendar ${i + 1} is listed twice` : `Calendar ${i + 1}: the address should look like https://calendar.google.com/calendar/ical/…/basic.ics`);
    seenUrls.add(c.url);
  }
  const token = $('notionToken').value.trim();
  const db = $('notionDatabase').value.trim();
  mark('notionToken', token !== '' && !/^[A-Za-z0-9_\-]{20,}$/.test(token), 'The Notion token looks malformed');
  mark('notionDatabase', db !== '' && !parseNotionId(db), 'Could not find a database ID in the Notion URL');
  if ((token === '') !== (db === '')) errors.push('Notion needs both a token and a database');
  const opts = statusOptions();
  const done = new Set(doneList());
  mark('prop-doneValues', !!opts && opts.length > 0 && opts.every((o) => done.has(o.toLowerCase())),
    'Finished status values cover every option, so no to-dos would show');
  mark('alphaVantageKey', !/^[A-Za-z0-9]*$/.test($('alphaVantageKey').value.trim()), 'The Alpha Vantage key should be letters and digits');
  return errors;
}

async function save(e) {
  e.preventDefault();
  const errors = validate();
  if (errors.length) return setMsg(errors[0], 'err');
  const notionProps = {};
  for (const k of PROP_KEYS) notionProps[k] = $(`prop-${k}`).value.trim() || DEFAULT_CONFIG.notionProps[k];
  const config = {
    calendars: readCals().filter((c) => c.url).map(({ url, name }) => ({ url, name })),
    notionToken: $('notionToken').value.trim(),
    notionDatabase: $('notionDatabase').value.trim(),
    notionProps,
    alphaVantageKey: $('alphaVantageKey').value.trim(),
  };
  await B.storage.local.set({ config });
  setMsg('Saved. Fetching…', 'ok');
  if (!(await checkPermissions())) return setMsg('Saved — now click "Grant access" above so the dashboard can fetch data.', 'err');
  await refresh();
}

async function refresh() {
  try {
    await B.runtime.sendMessage({ type: 'refresh' });
    setMsg('Refreshed (rate limits respected).', 'ok');
  } catch (e) {
    setMsg(`Refresh failed: ${e.message}`, 'err');
  }
}

async function checkPermissions() {
  const ok = await B.permissions.contains({ origins: ORIGINS });
  $('perm-section').hidden = ok;
  $('perm-hosts').textContent = `Hosts: ${ORIGINS.map((o) => new URL(o.replace('*', 'x')).host).join(', ')}`;
  return ok;
}

function when(ms, now) {
  if (!ms) return 'never';
  return dateStr(ms) === dateStr(now) ? fmtClock(ms) : `${fmtShortDate(dateStr(ms))} ${fmtClock(ms)}`;
}

async function renderStatus() {
  const s = await B.storage.local.get(null);
  const now = Date.now();
  const rows = [];
  const row = (name, rec) => rows.push(h('tr', null,
    h('td', null, name),
    h('td', null, `updated ${when(rec?.fetchedAt, now)}`),
    h('td', { class: rec?.error ? 'err' : null }, rec?.error || 'ok')));
  row('Weather', s.weather);
  row('Seasonal outlook', s.weatherOutlook);
  row('Calendars', s.calendar);
  for (const c of s.calendar?.data?.calendars || []) {
    rows.push(h('tr', null,
      h('td', null, h('span', { style: { color: c.color } }, '● '), c.name),
      h('td', null, `${(s.calendar.data.events || []).filter((e) => e.cal === s.calendar.data.calendars.indexOf(c)).length} events in range`),
      h('td', { class: c.error ? 'err' : null }, c.error || 'ok')));
  }
  row('Notion', s.notion);
  row('Alpha Vantage', s.quotes?.sources?.alphaVantage);
  row('VWRA history', s.vwraHistory);
  rows.push(h('tr', null, h('td', null, 'Budgets'), h('td', { colspan: 2 },
    `Alpha Vantage ${avCallsToday(s.avBudget, now)}/${AV_DAILY_CAP} today (UTC) · ` +
    `VWRA history ${(s.vwraHistory?.data || []).length} days`)));
  replace($('status').tBodies[0], rows);
}

document.addEventListener('DOMContentLoaded', async () => {
  await load();
  notionMeta = (await B.storage.local.get('notionMeta')).notionMeta || null;
  renderStatusHint();
  $('prop-doneValues').addEventListener('input', renderStatusHint);
  $('prop-status').addEventListener('input', renderStatusHint);
  await checkPermissions();
  await renderStatus();
  $('form').addEventListener('submit', save);
  $('add-cal').addEventListener('click', () => {
    if (document.querySelectorAll('.cal-row').length >= MAX_CALENDARS) return;
    $('cal-list').appendChild(calRow());
    renumberCals();
    document.querySelector('.cal-row:last-child .cal-url').focus();
  });
  $('refresh').addEventListener('click', refresh);
  $('grant').addEventListener('click', async () => {
    // Must be called directly from the click handler (user gesture).
    const ok = await B.permissions.request({ origins: ORIGINS });
    await checkPermissions();
    if (ok) await refresh();
  });
  for (const btn of document.querySelectorAll('.reveal')) {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.for);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
    });
  }
  B.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.notionMeta) { notionMeta = changes.notionMeta.newValue || null; renderStatusHint(); }
    renderStatus();
  });
});
