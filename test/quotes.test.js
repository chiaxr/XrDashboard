import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lseState, vwraQuoteDue, vwraHistoryDue, avBudgetSpend, appendQuoteToHistory, normaliseAvQuote, normaliseAvHistory,
} from '../lib/quotes.js';

const utc = (s) => Date.parse(s); // London is on GMT in November
const MIN = 60000, HOUR = 60 * MIN;

test('LSE state', () => {
  assert.deepEqual(
    (({ open, settled, lastClose }) => ({ open, settled, lastClose }))(lseState(utc('2026-11-19T10:00:00Z'))),
    { open: true, settled: false, lastClose: '2026-11-18' });
  assert.equal(lseState(utc('2026-11-19T17:00:00Z')).lastClose, '2026-11-19');
  assert.equal(lseState(utc('2026-11-21T12:00:00Z')).lastClose, '2026-11-20', 'Saturday → Friday');
  assert.equal(lseState(utc('2026-11-23T07:00:00Z')).lastClose, '2026-11-20', 'Monday pre-open → Friday');
});

test('VWRA quote cadence: every 2h while open, once after close, not on weekends', () => {
  const thu10 = utc('2026-11-19T10:00:00Z');
  const q = { day: '2026-11-19' };
  assert.equal(vwraQuoteDue(thu10, null, 0), true);
  assert.equal(vwraQuoteDue(thu10, q, thu10 - HOUR), false);
  assert.equal(vwraQuoteDue(thu10, q, thu10 - 2 * HOUR), true);
  assert.equal(vwraQuoteDue(thu10, q, thu10 - 5 * MIN), false, 'error retry gate');
  const thu17 = utc('2026-11-19T17:00:00Z');
  assert.equal(vwraQuoteDue(thu17, q, utc('2026-11-19T15:00:00Z')), true, 'fetch settled close');
  assert.equal(vwraQuoteDue(thu17, q, utc('2026-11-19T16:45:00Z'), utc('2026-11-19T16:45:00Z')), false, 'already have settled close');
  const sat = utc('2026-11-21T12:00:00Z');
  const fri1645 = utc('2026-11-20T16:45:00Z');
  assert.equal(vwraQuoteDue(sat, { day: '2026-11-20' }, fri1645, fri1645), false, 'weekend: nothing');
  assert.equal(vwraQuoteDue(sat, { day: '2026-11-19' }, sat - 20 * HOUR, sat - 20 * HOUR), true, 'missed Friday close');
  const thu1630 = utc('2026-11-19T16:35:00Z');
  assert.equal(vwraQuoteDue(thu1630, q, utc('2026-11-19T14:00:00Z'), utc('2026-11-19T14:00:00Z')), false, 'wait for close to settle');
  const fri07 = utc('2026-11-20T07:00:00Z');
  assert.equal(vwraQuoteDue(fri07, q, utc('2026-11-19T16:45:00Z'), utc('2026-11-19T16:45:00Z')), false, 'before open: have close');
});

test('VWRA quote: a failed close fetch is retried, a successful one is final', () => {
  const thu17 = utc('2026-11-19T17:00:00Z');
  const q = { day: '2026-11-19' };
  // Last success at 14:00, attempt at 16:42 failed → retry once the 15-min gate passes.
  assert.equal(vwraQuoteDue(thu17, q, utc('2026-11-19T16:42:00Z'), utc('2026-11-19T14:00:00Z')), true);
});

test('VWRA quote on an LSE holiday: one fetch after close, then nothing', () => {
  // Fri 25 Dec 2026 is a holiday; AV keeps reporting Thu 24 Dec.
  const q = { day: '2026-12-24' };
  const fri1700 = utc('2026-12-25T17:00:00Z');
  const thu1645 = utc('2026-12-24T16:45:00Z');
  assert.equal(vwraQuoteDue(fri1700, q, thu1645, thu1645), true, 'one try after the "close"');
  const fri1645 = utc('2026-12-25T16:45:00Z');
  for (const t of ['2026-12-25T18:00:00Z', '2026-12-25T23:00:00Z', '2026-12-26T12:00:00Z', '2026-12-27T20:00:00Z', '2026-12-28T07:00:00Z']) {
    assert.equal(vwraQuoteDue(utc(t), q, fri1645, fri1645), false, `no retries at ${t}`);
  }
});

test('VWRA backfill only when history is missing or has a long gap', () => {
  const now = utc('2026-11-19T10:00:00Z');
  const hist = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, close: 1 }));
  assert.equal(vwraHistoryDue(now, [], 0), true);
  assert.equal(vwraHistoryDue(now, hist, 0), true, 'last entry 31 Oct is > 10 days old');
  assert.equal(vwraHistoryDue(now, [...hist, { date: '2026-11-18', close: 1 }], 0), false);
  assert.equal(vwraHistoryDue(now, [], now - HOUR), false, 'retry gate');
});

test('Alpha Vantage daily cap never exceeded', () => {
  const now = utc('2026-11-19T10:00:00Z');
  let b = null;
  for (let i = 0; i < 15; i++) { b = avBudgetSpend(b, now); assert.ok(b); }
  assert.equal(avBudgetSpend(b, now), null);
  assert.deepEqual(avBudgetSpend(b, utc('2026-11-20T00:01:00Z')), { day: '2026-11-20', count: 1 });
});

test('history: provisional intraday price finalised by next day previous close', () => {
  let h = [{ date: '2026-11-17', close: 180 }];
  h = appendQuoteToHistory(h, { day: '2026-11-18', price: 181.0, prevClose: 180 }, utc('2026-11-18T11:00:00Z'));
  assert.deepEqual(h.at(-1), { date: '2026-11-18', close: 181.0, provisional: true });
  h = appendQuoteToHistory(h, { day: '2026-11-19', price: 182.5, prevClose: 181.28 }, utc('2026-11-19T09:00:00Z'));
  assert.deepEqual(h.at(-2), { date: '2026-11-18', close: 181.28 });
  h = appendQuoteToHistory(h, { day: '2026-11-19', price: 182.9, prevClose: 181.28 }, utc('2026-11-19T17:00:00Z'));
  assert.deepEqual(h.at(-1), { date: '2026-11-19', close: 182.9 });
  assert.equal(h.length, 3);
});

test('Alpha Vantage normalisation and rate-limit messages', () => {
  const q = normaliseAvQuote({ 'Global Quote': {
    '01. symbol': 'VWRA.LON', '05. price': '181.2800', '07. latest trading day': '2026-11-18',
    '08. previous close': '182.1800', '09. change': '-0.9000', '10. change percent': '-0.4940%',
  } });
  assert.deepEqual(q, { price: 181.28, prevClose: 182.18, change: -0.9, changePct: -0.494, day: '2026-11-18' });
  assert.throws(() => normaliseAvQuote({ Information: 'rate limit' }), /rate limit/);
  assert.throws(() => normaliseAvQuote({ 'Global Quote': {} }), /missing/);
  const h = normaliseAvHistory({ 'Time Series (Daily)': {
    '2026-11-18': { '4. close': '181.28' }, '2026-11-17': { '4. close': '182.18' }, bad: { '4. close': 'x' },
  } });
  assert.deepEqual(h.map((r) => r.date), ['2026-11-17', '2026-11-18']);
});
