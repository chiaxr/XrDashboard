# New Tab Dashboard — Firefox extension

A personal Firefox new-tab page showing: an hourly weather strip and the VWRA ticker, weather for
Philadelphia (16-day and monthly views), today's Google Calendar schedule, and Notion
to-dos matched to free gaps in the schedule. Single user, single machine (macOS).

The visual design is final: **design B ("Dense")**, reference mockup in
`design/dashboard-b.dc.html`. Match it closely (see "UI" below).

## Hard constraints

- **Firefox, Manifest V3 WebExtension.** `chrome_url_overrides.newtab` → `newtab.html`
  bundled in the extension. Background = MV3 event page (`background.scripts`), not a
  service worker.
- **No framework, no CDN, no remote code.** Plain HTML/CSS/JS (ES modules). System font
  stack only (`-apple-system, BlinkMacSystemFont, system-ui, sans-serif`; mono:
  `ui-monospace, Menlo, monospace`). Icons are inline SVG.
- **At most one third-party dependency:** `ical.js` (Mozilla) for ICS parsing and RRULE
  expansion, vendored into `vendor/` with its licence. Ask before adding anything else.
- **Metric units everywhere** (°C, km/h, mm). 24-hour times, except the header clock, which is
  12-hour with Singapore time (SGT) beside it. Timezone `America/New_York`.
- **Must render instantly from cache.** The new-tab page never waits on the network.

## Architecture

```
background.js   chrome.alarms → fetch each source → normalise → storage.local
newtab.html/js  read storage.local on load → render → storage.onChanged → re-render
options.html    enter/edit keys and settings (stored in storage.local only)
```

- Each source writes `{ data, fetchedAt, error? }` under its own key
  (`weather`, `weatherOutlook`, `calendar`, `notion`, `quotes`, `vwraHistory`).
- A failed fetch keeps the previous `data` and records `error`; the UI shows the
  last-good data with a stale marker (amber) — see mockup footer.
- Refresh on install, on browser start, and on alarms (cadences below). A manual
  "refresh now" is fine but must respect rate limits.

## Data sources

| Source | Use | Cadence | Notes |
|---|---|---|---|
| Open-Meteo forecast | Current + 16-day daily + hourly (next 36 h, for the 24 h strip) | 30 min | No key. `latitude=39.95&longitude=-75.17&forecast_days=16&forecast_hours=36&timezone=America/New_York`. Defaults are already metric. |
| Open-Meteo seasonal | "Monthly" view: 6 weekly rows (ECMWF EC46) + 3 months (SEAS5), anomaly vs usual + precip tendency | 6 h | Check the current Seasonal API docs for exact endpoint/params before coding. Label it as trends, not daily forecasts. |
| Google Calendar | Events from 7 days back to 30 days ahead (schedule day navigation) | 10 min | One or more **secret iCal addresses** (read-only, up to 8), pasted into Options. Parse with ical.js; expand recurrences and exceptions; convert to local time; drop declined/cancelled if present. Merge calendars (de-duplicate shared events); each gets an accent colour; a failing calendar keeps its last events. |
| Notion API | Open to-dos | 10 min | Internal integration with **Read content only**, shared with the to-do database only. Check the current API version / data-source query docs. |
| Alpha Vantage | VWRA (`VWRA.LON`) quote + daily history | quote ~every 2 h on LSE trading days; history once | Free tier: **25 requests/day, 5/min** — keep a daily call counter in storage and never exceed ~15. Backfill ~100 days once with `TIME_SERIES_DAILY` (compact), then append each day's close to `vwraHistory` locally. |

`host_permissions` must list exactly these hosts (plus the Google Calendar ICS host) —
never `<all_urls>`. Permissions: `storage`, `alarms`.

### Notion database expected fields

`Name` (title), `Status` (status/select; "Done" excluded), `Due` (date, optional),
`Estimate (min)` (number, optional), `Related event` (text, optional — matched
case-insensitively against today's event titles), `Priority` (select/number, optional —
orders items within groups and for gap filling). Make property names configurable in
Options so the user can map their existing database.

## Schedule ↔ to-do logic (pure functions, unit-tested)

1. Build today's timeline 08:00–20:00 from events; compute free gaps ≥ 15 min between
   now and 20:00 (ignore gaps already passed).
2. Group to-dos: **Overdue** (due < today) → **Prep for <event>** (Related event matches
   an upcoming event today) → **Today** (due today) → **This week** (due ≤ +7 days).
3. Gap filling: walk gaps in time order; place prep items before their event first,
   then overdue, then today, by priority; an item fits if `Estimate ≤ remaining gap`.
   Items without an estimate are listed but never auto-placed. Each gap shows at most
   two suggestions ("90m free → Prepare slides (60m)").
4. Footer stats: total estimated minutes due today, total free minutes in gaps, and
   "Fits" / "Over by Xh Ym".

## UI

Port `design/dashboard-b.dc.html` to plain HTML/CSS. That file is a design-tool
format: `{{x}}` holes are filled from `renderVals()` in its `<script>`, `<sc-for>` is
a loop and `<sc-if>` a conditional. The numbers in it are **sample data**; take layout,
spacing, colours and type from it, not values.

- Header: date/time (live 12-hour clock with SGT beside it), location + current temp, counts,
  privacy button.
- Top row (one line): hourly weather strip on the left — a summary ("Rain from 15:00" /
  "Dry next 24 h", temperature range) then 24 hourly chips (time, day/night icon, °C,
  rain chance ≥ 20%) that **scroll horizontally** (`flex-wrap: nowrap; overflow-x: auto`)
  when they don't fit. VWRA card (price, change, 50-day avg delta, 30-day range, 30-day
  sparkline from `vwraHistory`) on the right. On narrow windows VWRA wraps below the strip.
  The weather strip is not blurred in privacy mode. (The Twelve Data watchlist was removed.)
- Three panels: Schedule (hour grid, events, dashed free gaps with suggestions, orange
  now-line; ‹ Today › buttons and ←/→ keys to view other days; tomorrow by default from
  18:00), Weather (segmented toggle **16 days / Monthly**, choice persisted; Monthly is a
  Mon–Sun calendar of six weeks: daily forecast cells, then days tinted by the weekly
  anomaly, plus a weekly summary column and three season cards), To-do (grouped, footer stats).
- Footer: one status item per source with last-updated time; amber when stale/errored.
- To-dos are **read-only** in v1: clicking one opens its Notion page in a new tab. No
  checkbox write-back (the token is read-only by design).
- **Privacy mode:** `P` key and the header button toggle a blur on the ticker, schedule
  and to-dos; persisted; must not fire while typing in an input.
- States to implement: first run (no keys → friendly prompt linking to Options), loading
  from cache, per-panel error, empty day, weekend/market closed.

## Security rules (non-negotiable)

- **All external text is untrusted** (calendar invites can be written by anyone). Render
  with `textContent` / DOM APIs only. **Never** `innerHTML`, `insertAdjacentHTML`,
  `eval`, or `new Function`. Keep the default MV3 CSP.
- Keys and the iCal URL live only in `storage.local`, entered via Options. **Never**
  commit them, never hard-code them, never put them in `storage.sync`. Mozilla receives
  the source when signing.
- Only the exact API hosts in `host_permissions`. Validate/normalise every API response
  before storing.
- No analytics, no telemetry, no other network calls.

## Firefox install & signing

- Dev: `npx web-ext run` (temporary install) and `npx web-ext lint` (must pass clean).
- Permanent install in release Firefox requires signing: unlisted self-distribution via
  `npx web-ext sign --channel=unlisted` with AMO API credentials from environment
  variables (never in the repo). Set `browser_specific_settings.gecko.id`. Follow any
  current AMO manifest requirements that `web-ext lint` reports.
- Add a `.gitignore` covering `web-ext-artifacts/`, `.env`, and any local key files.

## Build order (each step runnable and checked before the next)

1. Skeleton: manifest, newtab override, options page, storage helpers, cache-first
   render with static placeholders. `web-ext lint` clean.
2. Weather (forecast + seasonal) end to end, including stale/error handling.
3. Calendar via iCal URL (recurring events, timezones, all-day events).
4. Notion to-dos + property mapping in Options.
5. Gap-fitting logic with unit tests (`node --test`, no extra deps).
6. Quotes: VWRA with daily call budget + local history; hourly weather strip beside it.
7. Privacy mode, weather toggle persistence, footer status, narrow-window layout.
8. Sign as unlisted and document install/update steps in `README.md`.

## Out of scope (v1)

Brokerage integrations, buy/sell recommendations, writing back to Calendar or Notion,
multiple locations, sync across devices.
