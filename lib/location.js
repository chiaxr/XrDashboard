// Where the weather is for: a place chosen in Options, the location Firefox detects, or the
// default (Philadelphia). Pure helpers shared by the background page, new tab and options.

import { LOCATION } from './config.js';

/** Moves smaller than this keep the current place (and its cached data). */
export const MOVE_KM = 25;
/** How often the new-tab page asks Firefox for the location (auto mode). */
export const DETECT_EVERY = 30 * 60 * 1000;
/** A detected place must stay current this long before its climate normals are fetched. */
export const SETTLE_MS = 12 * 60 * 60 * 1000;

const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round2 = (v) => Math.round(v * 100) / 100;
const inRange = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;

/** { name, country, latitude, longitude } with coordinates rounded to ~1 km, or null. */
export function validPlace(p) {
  if (!p || typeof p !== 'object' || !inRange(p.latitude, 90) || !inRange(p.longitude, 180)) return null;
  const name = typeof p.name === 'string' ? p.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const country = typeof p.country === 'string' ? p.country.trim().slice(0, 60) : '';
  return { name: name || 'Current location', country, latitude: round2(p.latitude), longitude: round2(p.longitude) };
}

/** Location settings from config: { mode: 'auto' | 'manual', place }. */
export function locationSettings(config) {
  const l = config?.location;
  return { mode: l?.mode === 'manual' ? 'manual' : 'auto', place: validPlace(l?.place) };
}

/** The place to fetch weather for, with `source`: 'manual' | 'auto' | 'default'. */
export function activeLocation(config, geo) {
  const { mode, place } = locationSettings(config);
  if (mode === 'manual' && place) return { ...place, source: 'manual' };
  const detected = mode === 'auto' ? validPlace(geo?.place) : null;
  if (detected) return { ...detected, source: 'auto' };
  return { ...LOCATION, country: 'United States', source: 'default' };
}

/**
 * Whether the place has been current long enough to fetch its climate normals: a place chosen
 * in Options (or the default) at once, a detected one after SETTLE_MS (geo.since = when it was
 * first detected), so passing through towns while travelling fetches nothing.
 */
export function isSettled(loc, geo, now) {
  if (loc?.source !== 'auto') return true;
  const since = Number(geo?.since);
  return Number.isFinite(since) && since > 0 && now - since >= SETTLE_MS;
}

/** Changes only when the place moves by about a kilometre: used to notice a new location. */
export const locationKey = (loc) => `${loc.latitude.toFixed(2)},${loc.longitude.toFixed(2)}`;

/** Within MOVE_KM of Philadelphia, where the bundled station normals and model scores apply. */
export const nearHome = (loc) => !!loc && distanceKm(loc, LOCATION) <= MOVE_KM;

/** A city's catchment radius in km: bigger cities claim more of their surroundings. */
export const cityRadius = (popThousands) => Math.max(3, 4 * Math.sqrt((Number(popThousands) || 0) / 100));

/**
 * City for coordinates from "name<TAB>country<TAB>lat<TAB>lon<TAB>population (thousands)" lines:
 * the one closest relative to its catchment radius (so a suburb near a big city gets the city,
 * a town centre gets the town); outside every city's area, simply the nearest.
 * { name, country, km, radius } or null.
 */
export function nearestCity(lines, latitude, longitude) {
  let best = null, nearest = null;
  const here = { latitude, longitude };
  for (const line of String(lines).split('\n')) {
    const [name, country, lat, lon, pop] = line.split('\t');
    const la = Number(lat), lo = Number(lon);
    if (!name || !Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (Math.abs(la - latitude) > 3) continue; // cheap pre-filter (~330 km)
    const km = distanceKm(here, { latitude: la, longitude: lo });
    const radius = cityRadius(pop);
    const c = { name, country, km, radius };
    if (!best || km / radius < best.km / best.radius) best = c;
    if (!nearest || km < nearest.km) nearest = c;
  }
  return best && best.km <= best.radius ? best : nearest;
}

/** Header name for detected coordinates: the city, or "Near …" when outside its area. */
export function placeName(city) {
  if (!city || city.km > 100) return 'Current location';
  return city.km > Math.max(MOVE_KM, city.radius ?? 0) ? `Near ${city.name}` : city.name;
}

/** Plain-language reason for a failed geolocation lookup. */
export function geoErrorText(err) {
  if (err?.code === 1) return 'Location access denied — allow Firefox in System Settings → Privacy & Security → Location Services';
  if (err?.code === 3) return 'Location lookup timed out';
  return `Location unavailable${err?.message ? `: ${String(err.message).slice(0, 120)}` : ''}`;
}
