import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThrottle, nextBackoff, inBackoff, BACKOFF_BASE, BACKOFF_MAX } from '../lib/backoff.js';
import { HttpError, parseRetryAfter } from '../lib/net.js';

const MIN = 60000;
const now = Date.parse('2026-11-19T12:00:00Z');

test('throttle errors: 429 and 5xx only', () => {
  assert.equal(isThrottle(new HttpError(429, 'x')), true);
  assert.equal(isThrottle(new HttpError(503, 'x')), true);
  assert.equal(isThrottle(new HttpError(404, 'x')), false);
  assert.equal(isThrottle(new Error('Network error')), false);
});

test('back-off doubles per failure and is capped', () => {
  const e = new HttpError(429, 'x');
  const b1 = nextBackoff(null, e, now);
  assert.deepEqual(b1, { fails: 1, until: now + BACKOFF_BASE });
  const b2 = nextBackoff(b1, e, now);
  assert.equal(b2.until - now, 2 * BACKOFF_BASE);
  let b = b2;
  for (let i = 0; i < 10; i++) b = nextBackoff(b, e, now);
  assert.equal(b.until - now, BACKOFF_MAX);
});

test('Retry-After lengthens the wait but never past the cap', () => {
  assert.equal(nextBackoff(null, new HttpError(429, 'x', 90 * MIN), now).until - now, 90 * MIN);
  assert.equal(nextBackoff(null, new HttpError(429, 'x', 5 * MIN), now).until - now, BACKOFF_BASE);
  assert.equal(nextBackoff(null, new HttpError(429, 'x', 48 * 60 * MIN), now).until - now, BACKOFF_MAX);
});

test('inBackoff', () => {
  assert.equal(inBackoff(null, now), false);
  assert.equal(inBackoff({ fails: 1, until: now + 1 }, now), true);
  assert.equal(inBackoff({ fails: 1, until: now }, now), false);
});

test('parseRetryAfter: seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('120', now), 120000);
  assert.equal(parseRetryAfter('Thu, 19 Nov 2026 12:30:00 GMT', now), 30 * MIN);
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter('soon', now), null);
});
