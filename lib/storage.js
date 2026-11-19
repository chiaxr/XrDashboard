// Thin promise wrappers over browser.storage.local (Firefox exposes `browser`).

const api = () => globalThis.browser ?? globalThis.chrome;

export async function getAll() {
  return api().storage.local.get(null);
}

export async function get(key) {
  const r = await api().storage.local.get(key);
  return r[key];
}

export async function set(obj) {
  return api().storage.local.set(obj);
}

/** Merge a patch into a source record ({ data, fetchedAt, attemptedAt, error }). */
export async function patchRecord(key, patch) {
  const prev = (await get(key)) || {};
  const next = { ...prev, ...patch };
  if (patch.error === null) delete next.error;
  await set({ [key]: next });
  return next;
}

/** Store fresh data: clears the error. */
export function saveData(key, data, extra = {}) {
  return patchRecord(key, { data, fetchedAt: Date.now(), error: null, ...extra });
}

/** Record a failure: keeps previous data, records the error. */
export function saveError(key, err, extra = {}) {
  const message = String((err && err.message) || err || 'Unknown error').slice(0, 300);
  return patchRecord(key, { error: message, errorAt: Date.now(), ...extra });
}
