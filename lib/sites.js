// Most-visited sites (Firefox topSites API). Local browser data, no network calls.

export const TOP_SITES_LIMIT = 12;

const HEX = /^#[0-9a-f]{6}$/i;

/** "www.github.com" → "github.com". Falls back to the raw host. */
export function siteLabel(hostname) {
  return hostname.replace(/^www\./i, '');
}

/**
 * Validate topSites.get() output into [{ url, host, title, favicon }].
 * Only http(s) links are kept, and favicons only as inline data:image URLs (never a remote
 * URL, so rendering one can't trigger a network request). One entry per host.
 */
export function normaliseTopSites(list, limit = TOP_SITES_LIMIT) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;
    let u;
    try { u = new URL(item.url); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const host = u.hostname.toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const fav = typeof item.favicon === 'string' && /^data:image\/[a-z0-9.+-]+[;,]/i.test(item.favicon)
      && item.favicon.length <= 200_000 ? item.favicon : null;
    out.push({ url: u.href, host: siteLabel(host), title, favicon: fav });
    if (out.length >= limit) break;
  }
  return out;
}

/** Chip text: the page title, or the hostname when the page has none. */
export function siteText(site) {
  return site.title || site.host;
}

/** A stored accent is used only if it is a plain #rrggbb colour. */
export function validAccent(accent) {
  return typeof accent === 'string' && HEX.test(accent) ? accent : null;
}

function hsl(r, g, b) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r / 255) h = ((g - b) / 255 / d) % 6;
  else if (max === g / 255) h = (b - r) / 255 / d + 2;
  else h = (r - g) / 255 / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');

/**
 * Main colour of a favicon from its RGBA pixels (canvas ImageData.data layout).
 * Ignores transparent, grey, near-black and near-white pixels, buckets the rest by hue
 * (weighted by saturation) and returns the average colour of the strongest bucket as
 * "#rrggbb". Returns null when the icon is mostly neutral (black/white/grey logos).
 */
export function dominantColour(px) {
  if (!px || px.length < 4) return null;
  const BUCKETS = 18; // 20° each
  const w = new Array(BUCKETS).fill(0);
  const sum = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
  let opaque = 0, colourful = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (a < 128) continue;
    opaque++;
    const c = hsl(r, g, b);
    if (c.s < 0.25 || c.l < 0.12 || c.l > 0.92) continue;
    colourful++;
    const k = Math.floor(c.h / (360 / BUCKETS)) % BUCKETS;
    const wt = c.s;
    w[k] += wt;
    sum[k][0] += r * wt; sum[k][1] += g * wt; sum[k][2] += b * wt;
  }
  if (!opaque || colourful / opaque < 0.08) return null;
  let best = 0;
  for (let k = 1; k < BUCKETS; k++) if (w[k] > w[best]) best = k;
  const [r, g, b] = sum[best].map((v) => v / w[best]);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** True when two lists would render identically (skip needless storage writes). */
export function sameSites(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => x.url === b[i].url && x.host === b[i].host && x.title === b[i].title
    && x.favicon === b[i].favicon
    && (x.accent ?? null) === (b[i].accent ?? null));
}
