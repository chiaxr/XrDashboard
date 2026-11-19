// Static configuration shared by the background page, new tab and options page.

export const TZ = 'America/New_York';
export const LOCATION = { name: 'Philadelphia', latitude: 39.95, longitude: -75.17 };

// Storage keys for source records: each holds { data, fetchedAt, attemptedAt, error? }.
export const SOURCES = ['weather', 'weatherOutlook', 'calendar', 'notion', 'quotes', 'vwraHistory'];

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;

// How often each source is refreshed, and how old data may get before the UI marks it stale.
export const CADENCE = {
  weather: 30 * MIN,
  weatherOutlook: 6 * HOUR,
  calendar: 10 * MIN,
  notion: 10 * MIN,
};
export const STALE_AFTER = {
  weather: 90 * MIN,
  weatherOutlook: 18 * HOUR,
  calendar: 30 * MIN,
  notion: 30 * MIN,
  alphaVantage: 6 * HOUR,
};
// Manual "refresh now" never refetches faster than this.
export const MANUAL_MIN_INTERVAL = {
  weather: 5 * MIN,
  weatherOutlook: 30 * MIN,
  calendar: 1 * MIN,
  notion: 1 * MIN,
};

// Alpha Vantage free tier is 25/day; stay well below.
export const AV_DAILY_CAP = 15;
export const AV_QUOTE_INTERVAL = 2 * HOUR;

export const DEFAULT_CONFIG = {
  // Google Calendar secret iCal addresses: [{ url, name }]. Name is optional (defaults to the
  // calendar's own name from the feed).
  calendars: [],
  notionToken: '',
  notionDatabase: '',
  notionProps: {
    title: 'Name',
    status: 'Status',
    doneValues: 'Done',
    due: 'Due',
    estimate: 'Estimate (min)',
    related: 'Related event',
    priority: 'Priority',
  },
  alphaVantageKey: '',
};

export const DEFAULT_UI = { privacy: false, weatherView: 'days' };

export function withDefaults(config) {
  const c = config && typeof config === 'object' ? config : {};
  // Older settings stored a single `icalUrl`, and Twelve Data watchlist settings (removed).
  const calendars = Array.isArray(c.calendars)
    ? c.calendars
    : (typeof c.icalUrl === 'string' && c.icalUrl.trim() ? [{ url: c.icalUrl.trim(), name: '' }] : []);
  const { icalUrl, twelveDataKey, watchlist, ...rest } = c;
  void icalUrl; void twelveDataKey; void watchlist;
  return {
    ...DEFAULT_CONFIG,
    ...rest,
    calendars: calendars
      .filter((x) => x && typeof x.url === 'string' && x.url.trim())
      .map((x) => ({ url: x.url.trim(), name: typeof x.name === 'string' ? x.name.trim().slice(0, 60) : '' })),
    notionProps: { ...DEFAULT_CONFIG.notionProps, ...(c.notionProps || {}) },
  };
}

export const MAX_CALENDARS = 8;
// Per-calendar accent colours (left edge of events, legend).
export const CALENDAR_COLORS = ['#79B8FF', '#3FB950', '#D29922', '#DB61A2', '#A371F7', '#F0883E', '#56D4DD', '#E6EDF3'];

export const HOSTS = {
  forecast: 'https://api.open-meteo.com',
  seasonal: 'https://seasonal-api.open-meteo.com',
  calendar: 'https://calendar.google.com',
  notion: 'https://api.notion.com',
  alphaVantage: 'https://www.alphavantage.co',
};
