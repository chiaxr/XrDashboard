// Market data: VWRA from Alpha Vantage (strict daily call budget, local history).
// Scheduling and budget helpers are pure and unit-tested.

import { HOSTS, MIN, HOUR, AV_DAILY_CAP, AV_QUOTE_INTERVAL } from './config.js';
import { zonedParts, dateStr, addDays, weekdayOf, zonedToInstant } from './time.js';
import { fetchJson } from './net.js';

export const VWRA_SYMBOL = 'VWRA.LON';
const LONDON = 'Europe/London';
const LSE_OPEN = 8 * 60, LSE_CLOSE = 16 * 60 + 30, LSE_CLOSE_SETTLED = 16 * 60 + 40;

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
};
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ── market calendars (weekday-only; exchange holidays just return the previous close) ──

const minutesIn = (ms, tz) => { const p = zonedParts(ms, tz); return p.hour * 60 + p.minute; };
const isWeekday = (d) => { const w = weekdayOf(d); return w >= 1 && w <= 5; };
function prevWeekday(d) {
  let x = addDays(d, -1);
  while (!isWeekday(x)) x = addDays(x, -1);
  return x;
}

export function lseState(now) {
  const date = dateStr(now, LONDON);
  const min = minutesIn(now, LONDON);
  const tradingDay = isWeekday(date);
  const open = tradingDay && min >= LSE_OPEN && min < LSE_CLOSE;
  const settled = tradingDay && min >= LSE_CLOSE_SETTLED;
  // The most recent session whose close is final.
  const lastClose = settled ? date : prevWeekday(date);
  return { date, min, tradingDay, open, settled, lastClose };
}

/**
 * Should we call Alpha Vantage GLOBAL_QUOTE now? (budget checked separately)
 * `attemptedAt` = last call (success or not), `fetchedAt` = last successful call.
 * While the LSE is open: every 2 h. While closed: once, after the last session's close has
 * settled. A successful fetch after that point is final even if it still reports an older
 * day; that happens on exchange holidays, which this weekday-only calendar can't see.
 */
export function vwraQuoteDue(now, quote, attemptedAt = 0, fetchedAt = 0) {
  if (now - attemptedAt < 15 * MIN) return false;
  if (!quote || !isDate(quote.day)) return true;
  const st = lseState(now);
  if (st.open) return now - attemptedAt >= AV_QUOTE_INTERVAL;
  return fetchedAt < zonedToInstant(st.lastClose, LSE_CLOSE_SETTLED, LONDON);
}

export function vwraHistoryDue(now, history, attemptedAt = 0) {
  if (now - attemptedAt < 6 * HOUR) return false;
  if (!Array.isArray(history) || history.length < 20) return true;
  const last = history[history.length - 1].date;
  return last < addDays(dateStr(now, LONDON), -10);
}

// ── budgets ──

/** Alpha Vantage: never more than AV_DAILY_CAP calls per UTC day. */
export function avBudgetSpend(budget, now, n = 1) {
  const day = new Date(now).toISOString().slice(0, 10);
  const count = budget && budget.day === day ? budget.count : 0;
  if (count + n > AV_DAILY_CAP) return null;
  return { day, count: count + n };
}

export function avCallsToday(budget, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return budget && budget.day === day ? budget.count : 0;
}

// ── Alpha Vantage ──

function avCheck(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Alpha Vantage: bad response');
  const msg = raw['Error Message'] || raw.Note || raw.Information;
  if (msg) throw new Error(`Alpha Vantage: ${String(msg).slice(0, 160)}`);
}

export async function fetchVwraQuote(key) {
  const q = new URLSearchParams({ function: 'GLOBAL_QUOTE', symbol: VWRA_SYMBOL, apikey: key });
  return normaliseAvQuote(await fetchJson(`${HOSTS.alphaVantage}/query?${q}`));
}

export async function fetchVwraHistory(key) {
  const q = new URLSearchParams({ function: 'TIME_SERIES_DAILY', symbol: VWRA_SYMBOL, outputsize: 'compact', apikey: key });
  return normaliseAvHistory(await fetchJson(`${HOSTS.alphaVantage}/query?${q}`));
}

export function normaliseAvQuote(raw) {
  avCheck(raw);
  const g = raw['Global Quote'];
  if (!g || typeof g !== 'object') throw new Error('Alpha Vantage: no quote in response');
  const price = num(g['05. price']);
  const prevClose = num(g['08. previous close']);
  const day = g['07. latest trading day'];
  if (price == null || !isDate(day)) throw new Error('Alpha Vantage: quote missing price/day');
  const change = num(g['09. change']) ?? (prevClose != null ? price - prevClose : null);
  const changePct = num(g['10. change percent']) ?? (prevClose ? (change / prevClose) * 100 : null);
  return { price, prevClose, change, changePct, day };
}

export function normaliseAvHistory(raw) {
  avCheck(raw);
  const series = raw['Time Series (Daily)'];
  if (!series || typeof series !== 'object') throw new Error('Alpha Vantage: no daily series');
  const out = [];
  for (const [date, row] of Object.entries(series)) {
    const close = num(row?.['4. close']);
    if (isDate(date) && close != null && close > 0) out.push({ date, close });
  }
  if (!out.length) throw new Error('Alpha Vantage: empty daily series');
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Merge backfilled history (oldest→newest), keeping at most `max` days. */
export function mergeHistory(existing, incoming, max = 400) {
  const map = new Map((existing || []).map((r) => [r.date, r]));
  for (const r of incoming) map.set(r.date, { date: r.date, close: r.close });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-max);
}

/**
 * Append today's quote to the local history: the quote day's price is provisional until
 * the LSE close settles; a later quote's previous close finalises the earlier day.
 */
export function appendQuoteToHistory(history, quote, now) {
  const h = [...(history || [])];
  const last = h[h.length - 1];
  if (last && last.provisional && last.date < quote.day && quote.prevClose != null) {
    h[h.length - 1] = { date: last.date, close: quote.prevClose };
  }
  const st = lseState(now);
  const provisional = !(quote.day < st.date || (quote.day === st.date && st.settled));
  const entry = provisional ? { date: quote.day, close: quote.price, provisional: true } : { date: quote.day, close: quote.price };
  const idx = h.findIndex((r) => r.date === quote.day);
  if (idx >= 0) h[idx] = entry; else h.push(entry);
  return h.sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
}
