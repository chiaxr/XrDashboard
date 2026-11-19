// Network helpers. Only called from the background page; host_permissions gate every host.

const TIMEOUT_MS = 20000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function fetchRaw(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      ...init, signal: ctrl.signal,
    });
    return res;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Request timed out' : `Network error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, init) {
  const res = await fetchRaw(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (body && (body.message || body.reason || body.error)) || res.statusText || 'request failed';
    throw new HttpError(res.status, `HTTP ${res.status}: ${String(msg).slice(0, 200)}`);
  }
  if (body == null) throw new Error('Response was not JSON');
  return body;
}

export async function fetchText(url, init) {
  const res = await fetchRaw(url, init);
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  return res.text();
}
