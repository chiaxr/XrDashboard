// Back-off after a server says "slow down" (HTTP 429) or is failing (5xx).
// State: { fails, until } — no request to that resource before `until`, manual refresh included.

import { MIN, HOUR } from './config.js';

export const BACKOFF_BASE = 20 * MIN;
export const BACKOFF_MAX = 6 * HOUR;

/** True for errors that mean "stop asking for a while" rather than "bad request". */
export function isThrottle(err) {
  const s = err?.status;
  return s === 429 || (s >= 500 && s < 600);
}

/** Next back-off state: doubles per consecutive failure, never shorter than Retry-After. */
export function nextBackoff(prev, err, now, { base = BACKOFF_BASE, max = BACKOFF_MAX } = {}) {
  const fails = (prev?.fails || 0) + 1;
  let wait = Math.min(base * 2 ** (fails - 1), max);
  if (err?.retryAfterMs > wait) wait = Math.min(err.retryAfterMs, max);
  return { fails, until: now + wait };
}

export function inBackoff(state, now) {
  return !!state && state.until > now;
}
