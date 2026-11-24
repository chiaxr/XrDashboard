// MV3 event page: alarms → fetch each source → normalise → storage.local.
// Each source record: { data, fetchedAt, attemptedAt, error?, errorAt?, configHash? }.
// A failed fetch keeps the previous data and records `error`.

import {
  CADENCE, MANUAL_MIN_INTERVAL, MIN, HOSTS, withDefaults, CALENDAR_COLORS, MAX_CALENDARS,
} from './lib/config.js';
import { getAll, get, set, patchRecord, saveData, saveError } from './lib/storage.js';
import { fetchForecast, fetchOutlook, fetchNormals } from './lib/weather.js';
import { activeLocation, locationKey, nearHome, isSettled } from './lib/location.js';
import { normalsList, findNormals, withNormals } from './lib/climate.js';
import { fetchCalendar, isValidIcalUrl, mergeCalendars } from './lib/calendar.js';
import { fetchNotion, parseNotionId } from './lib/notion.js';
import {
  fetchVwraQuote, fetchVwraHistory, vwraQuoteDue, vwraHistoryDue, avBudgetSpend, mergeHistory, appendQuoteToHistory,
  lseState,
} from './lib/quotes.js';
import { dateStr, fmtClock } from './lib/time.js';
import { inBackoff, nextBackoff, isThrottle } from './lib/backoff.js';

const B = globalThis.browser;
const TICK = 'tick';
const TICK_MINUTES = 5;
const SLACK = MIN; // alarms are not exact; treat "almost due" as due

// ── small utilities ──────────────────────────────────────────────────────

const locks = new Map();
/** Serialise async read-modify-write sections that share a storage key. */
function withLock(name, fn) {
  const prev = locks.get(name) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(name, next.catch(() => {}));
  return next;
}

const inFlight = new Map();
function once(name, fn) {
  if (inFlight.has(name)) return inFlight.get(name);
  const p = Promise.resolve().then(fn).finally(() => inFlight.delete(name));
  inFlight.set(name, p);
  return p;
}

/** FNV-1a, used only to notice that a source's settings changed. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

async function hasHost(origin) {
  try {
    return await B.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return true;
  }
}

async function requireHost(origin) {
  if (!(await hasHost(origin))) {
    throw new Error(`Access to ${new URL(origin).host} not granted — open Options and click "Grant access"`);
  }
}

function isDue(rec, cadence, { now, manual, configHash, minManual }) {
  const attempted = rec?.attemptedAt || 0;
  const since = now - attempted;
  if (configHash && rec && rec.configHash !== configHash) return true; // settings changed
  if (inBackoff(rec?.backoff, now)) return false; // rate-limited: wait, even for manual refresh
  if (manual) return since >= minManual;
  if (!rec || rec.error) return since >= Math.min(cadence, 10 * MIN) - SLACK;
  return since >= cadence - SLACK;
}

/** Generic fetch → save for a simple source. */
function runSimple(key, ctx, { cadence, minManual, configHash = null, host, fetcher, forceDue = false }) {
  const rec = ctx.store[key];
  const due = isDue(rec, cadence, { ...ctx, configHash, minManual });
  if (!due && !(forceDue && !inBackoff(rec?.backoff, ctx.now))) return null;
  return once(key, async () => {
    await patchRecord(key, { attemptedAt: ctx.now });
    const extra = configHash ? { configHash } : {};
    try {
      await requireHost(host);
      const data = await fetcher();
      await saveData(key, data, { ...extra, backoff: null });
    } catch (e) {
      if (!isThrottle(e)) return saveError(key, e, extra);
      const backoff = nextBackoff(rec?.backoff, e, ctx.now);
      await saveError(key, `${e.message} — rate limited, next try ${fmtClock(backoff.until)}`, { ...extra, backoff });
    }
  });
}

// ── sources ──────────────────────────────────────────────────────────────

// Weather sources carry the location in configHash, so a new place refetches straight away.
function refreshWeather(ctx) {
  const rec = ctx.store.weather;
  return runSimple('weather', ctx, {
    cadence: CADENCE.weather, minManual: MANUAL_MIN_INTERVAL.weather, host: HOSTS.forecast,
    configHash: locationKey(ctx.location), fetcher: () => fetchForecast(ctx.location),
    // Cached data from before the hourly strip existed: fetch once now rather than in 30 min.
    forceDue: !!rec?.data && !rec.error && !Array.isArray(rec.data.hours) && ctx.now - (rec.attemptedAt || 0) > MIN,
  });
}

function refreshOutlook(ctx) {
  return runSimple('weatherOutlook', ctx, {
    cadence: CADENCE.weatherOutlook, minManual: MANUAL_MIN_INTERVAL.weatherOutlook, host: HOSTS.seasonal,
    configHash: locationKey(ctx.location), fetcher: () => fetchOutlook(ctx.location),
  });
}

/**
 * Climate normals for the long-range estimate; near Philadelphia the bundled station table is used.
 * Elsewhere a saved table within 50 km is reused (the last 10 places are kept), and a new place is
 * fetched only once it has been current for 12 h, so travelling does not fetch at every stop.
 */
async function refreshNormals(ctx) {
  const loc = ctx.location;
  if (nearHome(loc)) return;
  const rec = ctx.store.normals;
  const list = normalsList(rec?.data);
  const saved = findNormals(list, loc);
  if (saved) {
    // Keep the most recently used first; an error from another place no longer applies.
    if (list[0] !== saved || rec?.error) {
      await withLock('normals', () => patchRecord('normals', { data: { places: withNormals(list, saved) }, error: null }));
    }
    return;
  }
  if (!isSettled(loc, ctx.store.geo, ctx.now)) return;
  await runSimple('normals', ctx, {
    cadence: CADENCE.normals, minManual: MANUAL_MIN_INTERVAL.normals, host: HOSTS.archive,
    configHash: locationKey(loc),
    fetcher: async () => ({ places: withNormals(list, await fetchNormals(loc)) }),
  });
}

/**
 * Fetch every configured calendar, one at a time; a failing one keeps its last events and
 * reports its error. A calendar Google rate-limits (429) is skipped until its back-off ends.
 */
async function fetchAllCalendars(cals, now, prev) {
  const today = dateStr(now);
  const prevById = new Map((prev?.calendars || []).map((c, i) => [c.id, { cal: c, index: i }]));
  const oldBackoff = (await get('calendarBackoff')) || {};
  const backoff = {};
  const results = [];
  for (const c of cals) {
    const id = hash(c.url);
    const b = oldBackoff[id];
    if (inBackoff(b, now)) {
      backoff[id] = b;
      results.push({ status: 'rejected', reason: new Error(`Rate limited by Google — next try ${fmtClock(b.until)}`) });
      continue;
    }
    if (results.some((r) => r.fetched)) await new Promise((r) => setTimeout(r, 1000)); // no bursts
    try {
      results.push({ status: 'fulfilled', fetched: true, value: await fetchCalendar(c.url, now) });
    } catch (e) {
      let reason = e;
      if (isThrottle(e)) {
        backoff[id] = nextBackoff(b, e, now);
        reason = new Error(`${e.message} — rate limited by Google, next try ${fmtClock(backoff[id].until)}`);
      } else if (b) {
        backoff[id] = b; // keep the failure count until a success
      }
      results.push({ status: 'rejected', fetched: true, reason });
    }
  }
  await set({ calendarBackoff: backoff });
  const inputs = cals.map((c, i) => {
    const id = hash(c.url);
    const old = prevById.get(id);
    const base = { id, name: c.name, color: CALENDAR_COLORS[i % CALENDAR_COLORS.length] };
    const r = results[i];
    if (r.status === 'fulfilled') return { ...base, result: r.value };
    return {
      ...base,
      error: r.reason?.message || String(r.reason),
      previous: old ? (prev.events || []).filter((e) => e.cal === old.index) : [],
      previousName: old?.cal?.name,
    };
  });
  if (results.every((r) => r.status === 'rejected')) {
    throw new Error(cals.length > 1 ? `All calendars failed: ${inputs[0].error}` : inputs[0].error);
  }
  return mergeCalendars(today, inputs);
}

function refreshCalendar(ctx) {
  const cals = ctx.config.calendars.slice(0, MAX_CALENDARS);
  if (!cals.length) return null;
  const bad = cals.findIndex((c) => !isValidIcalUrl(c.url));
  if (bad >= 0) return saveError('calendar', `Calendar ${bad + 1}: the address does not look like a Google Calendar secret iCal address`);
  const rec = ctx.store.calendar;
  // Calendar data is date-specific: refetch once as soon as the day rolls over. If that
  // attempt fails, the normal error retry interval applies (not every new tab).
  const today = dateStr(ctx.now);
  const stale = rec?.data && rec.data.today !== today;
  const triedToday = rec?.attemptedAt && dateStr(rec.attemptedAt) === today;
  return runSimple('calendar', ctx, {
    cadence: CADENCE.calendar, minManual: MANUAL_MIN_INTERVAL.calendar, host: HOSTS.calendar,
    configHash: hash(JSON.stringify(cals)), forceDue: stale && !triedToday,
    fetcher: () => fetchAllCalendars(cals, ctx.now, rec?.data),
  });
}

function refreshNotion(ctx) {
  const { notionToken, notionDatabase, notionProps } = ctx.config;
  if (!notionToken.trim() || !notionDatabase.trim()) return null;
  if (!parseNotionId(notionDatabase)) return saveError('notion', 'Notion database ID or URL not recognised');
  const configHash = hash(JSON.stringify([notionToken, parseNotionId(notionDatabase), notionProps]));
  return runSimple('notion', ctx, {
    cadence: CADENCE.notion, minManual: MANUAL_MIN_INTERVAL.notion, host: HOSTS.notion, configHash,
    fetcher: async () => {
      const { todos, meta } = await fetchNotion(ctx.config, await get('notionMeta'));
      await set({ notionMeta: meta });
      return { todos };
    },
  });
}

/** Read-modify-write the `quotes` record. */
function updateQuotes(mutator) {
  return withLock('quotes', async () => {
    const rec = (await get('quotes')) || {};
    const next = { data: { ...(rec.data || {}) }, sources: { ...(rec.sources || {}) } };
    mutator(next);
    const srcs = Object.values(next.sources);
    next.fetchedAt = Math.max(0, ...srcs.map((s) => s.fetchedAt || 0)) || undefined;
    const errs = srcs.filter((s) => s.error).map((s) => s.error);
    if (errs.length) next.error = errs[0];
    await set({ quotes: next });
    return next;
  });
}

const srcOk = (now, extra = {}) => ({ fetchedAt: now, attemptedAt: now, ...extra });
const srcErr = (prev, now, e) => ({ ...(prev || {}), attemptedAt: now, error: String(e?.message || e).slice(0, 300), errorAt: now });

/** Spend from a budget atomically; returns false if the call would exceed the cap. */
function spend(budgetKey, spender) {
  return withLock(budgetKey, async () => {
    const next = spender(await get(budgetKey));
    if (!next) return false;
    await set({ [budgetKey]: next });
    return true;
  });
}

function refreshVwra(ctx) {
  const key = ctx.config.alphaVantageKey.trim();
  if (!key) return null;
  return once('alphaVantage', async () => {
    const { now } = ctx;
    const store = await getAll();
    const sources = store.quotes?.sources || {};
    const histRec = store.vwraHistory;

    // 1) One-off backfill (and again only after a long gap).
    let calledHistory = false;
    if (vwraHistoryDue(now, histRec?.data, histRec?.attemptedAt)) {
      if (await spend('avBudget', (b) => avBudgetSpend(b, now))) {
        calledHistory = true;
        await patchRecord('vwraHistory', { attemptedAt: now });
        try {
          await requireHost(HOSTS.alphaVantage);
          const incoming = await fetchVwraHistory(key);
          await withLock('vwraHistory', async () => {
            const cur = (await get('vwraHistory'))?.data || [];
            await saveData('vwraHistory', mergeHistory(cur, incoming));
          });
        } catch (e) {
          await saveError('vwraHistory', e);
        }
      }
    }

    // 2) Quote on LSE schedule. Alpha Vantage also limits bursts to ~1 request/second.
    if (calledHistory) await new Promise((r) => setTimeout(r, 2000));
    const av = sources.alphaVantage;
    const quote = store.quotes?.data?.vwra;
    // Manual refresh can fetch an extra quote only while the market is open (a closed market's price can't change).
    const due = vwraQuoteDue(now, quote, av?.attemptedAt, av?.fetchedAt)
      || (ctx.manual && lseState(now).open && now - (av?.attemptedAt || 0) > 30 * MIN);
    if (!due) return;
    if (!(await spend('avBudget', (b) => avBudgetSpend(b, now)))) {
      await updateQuotes((q) => { q.sources.alphaVantage = { ...(q.sources.alphaVantage || {}), budgetBlockedAt: now }; });
      return;
    }
    try {
      await requireHost(HOSTS.alphaVantage);
      const vwra = await fetchVwraQuote(key);
      await updateQuotes((q) => { q.data.vwra = vwra; q.sources.alphaVantage = srcOk(now); });
      await withLock('vwraHistory', async () => {
        const rec = (await get('vwraHistory')) || {};
        await set({ vwraHistory: { ...rec, data: appendQuoteToHistory(rec.data || [], vwra, now) } });
      });
    } catch (e) {
      await updateQuotes((q) => { q.sources.alphaVantage = srcErr(q.sources.alphaVantage, now, e); });
    }
  });
}

// ── orchestration ────────────────────────────────────────────────────────

async function refreshAll({ manual = false } = {}) {
  const store = await getAll();
  const config = withDefaults(store.config);
  const ctx = { now: Date.now(), manual, store, config, location: activeLocation(config, store.geo) };
  const jobs = [
    refreshWeather(ctx), refreshOutlook(ctx), refreshNormals(ctx), refreshCalendar(ctx), refreshNotion(ctx),
    refreshVwra(ctx),
  ].filter(Boolean);
  await Promise.allSettled(jobs);
  await set({ lastTickAt: Date.now() });
}

/** Drop data left by removed features (the Twelve Data watchlist). */
async function cleanUpLegacy() {
  await B.storage.local.remove('tdBudget');
  const q = await get('quotes');
  if (q && (q.data?.watch || q.sources?.twelveData || q.sources?.twelveDataSeries)) {
    await updateQuotes((r) => {
      delete r.data.watch; delete r.data.series;
      delete r.sources.twelveData; delete r.sources.twelveDataSeries;
      delete r.error;
    });
  }
  const { config } = await B.storage.local.get('config');
  if (config && ('twelveDataKey' in config || 'watchlist' in config)) {
    const { twelveDataKey, watchlist, ...rest } = config;
    void twelveDataKey; void watchlist;
    await set({ config: rest });
  }
}

async function ensureAlarm() {
  const existing = await B.alarms.get(TICK);
  if (!existing) B.alarms.create(TICK, { delayInMinutes: 1, periodInMinutes: TICK_MINUTES });
}

// Browser start and install/update fetch only what is due (cached data covers the rest).
// Manual refresh (shorter minimum intervals) is only the Options page's Refresh button.
B.runtime.onInstalled.addListener(() => { ensureAlarm(); cleanUpLegacy().finally(() => refreshAll()); });
B.runtime.onStartup.addListener(() => { ensureAlarm(); refreshAll(); });
B.alarms.onAlarm.addListener((alarm) => { if (alarm.name === TICK) refreshAll(); });

B.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== B.runtime.id || !msg || typeof msg !== 'object') return undefined;
  if (msg.type === 'tick') return refreshAll().then(() => ({ ok: true }));
  if (msg.type === 'refresh') return refreshAll({ manual: true }).then(() => ({ ok: true }));
  return undefined;
});

ensureAlarm();
