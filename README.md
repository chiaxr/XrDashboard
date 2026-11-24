# New Tab Dashboard (Firefox)

A personal Firefox new-tab page: your most-visited sites, the next 24 hours of weather and VWRA, weather where you are (16 days and a
monthly outlook), today's Google Calendar, and Notion to-dos matched to free gaps in the day.

Manifest V3, plain HTML/CSS/JS, no remote code. The only third-party code is
[ical.js](https://github.com/kewisch/ical.js) 2.2.1 (MPL-2.0), vendored unmodified in
`vendor/ical.js/`. City names for the detected location come from
[GeoNames](https://www.geonames.org/) (CC BY 4.0), bundled in `lib/cities.js`.

## Layout

```
manifest.json        MV3; newtab override, event-page background, options page
background.js        alarms (5-min tick) → fetch what is due → normalise → storage.local
newtab.html/css/js   renders from storage.local instantly; re-renders on storage changes
options.html/css/js  keys + settings (storage.local only), site-access grant, status
lib/                 config, time zones, storage, DOM builder, one module per source,
                     plan.js (pure gap-fitting logic)
test/                node --test unit tests (calendar parsing, gap fitting, quote budgets)
design/              reference mockup (design B, "Dense")
```

Each source writes `{ data, fetchedAt, attemptedAt, error? }` to its own key (`weather`,
`weatherOutlook`, `calendar`, `notion`, `quotes`, `vwraHistory`). When a fetch fails, the
previous data stays and the footer item turns amber.

| Source | Cadence | Budget guard |
|---|---|---|
| Open-Meteo forecast (current, hourly, 16 days; NBM + ECMWF blend, see `docs/weather-models.md`) | 30 min | — |
| Open-Meteo seasonal (EC46 weekly + SEAS5 monthly) | 6 h | — |
| Google Calendar (secret iCal URL) | 10 min, and as soon as the day rolls over | — |
| Notion (data-source query, API `2026-03-11`) | 10 min | — |
| Alpha Vantage `VWRA.LON` | about every 2 h while the LSE is open, plus once after the close; 100-day backfill once | at most 15 calls per UTC day (`avBudget`), calls spaced ≥ 2 s apart |

"Refresh now" (Options) and browser start bypass the normal cadence but still respect
minimum intervals and both API budgets.

## Development

Requires Node 20+ and Firefox.

```bash
npm test
```

```bash
npx web-ext lint
```

```bash
npx web-ext run
```

`web-ext run` opens a temporary profile with the extension installed. Open a new tab to see
the dashboard. Weather works without any keys. The rest is set up in Options
(`about:addons` → New Tab Dashboard → Preferences).

## Setup (Options page)

1. **Site access.** If Options shows a "Grant access" box, click it. Firefox MV3 treats host
   permissions as user-grantable, and the dashboard only asks for its eight API hosts.
   After updating to a version with new hosts, click it again.
2. **Weather location.** *Detect automatically* (default) uses Firefox's location; on a Mac,
   allow Firefox under System Settings → Privacy & Security → Location Services. Or choose
   *Use a place*, search for a city and Save. Until a location is found, Philadelphia is used.
3. **Google Calendars.** For each calendar: Google Calendar → Settings → the calendar →
   *Integrate calendar* → *Secret address in iCal format*. Add up to 8 with *+ Add calendar*;
   they're merged into one schedule, each with its own accent colour. Recurring events, exceptions, time zones and all-day
   events are expanded locally. Declined invites (matched against the calendar owner in the
   URL) and cancelled events are dropped.
4. **Notion.** Create an *internal* integration with **Read content** only, then share just
   the to-do database with it (database ⋯ → Connections). Paste the token and the database
   URL. Map property names if yours differ: `Name`, `Status` (status/select/checkbox),
   done values (default `Done`), `Due`, `Estimate (min)`, `Related event`, and optionally
   `Priority` (select/status/number). Within each group, and when suggesting to-dos for free
   gaps, higher priority comes first (High/Urgent/P0–P1 before Medium/P2 before Low; other
   option names follow their order in Notion), then the earliest due date.
5. **Alpha Vantage** free API key (VWRA).

The page is drawn at 120% by default. To change that, edit `--ui-scale` in `newtab.css`, or
use Firefox's own zoom (Cmd +/−) on top.

Top-right buttons: the theme button cycles Auto → Light → Dark (remembered; its icon shows
the current choice), the eye toggles the privacy blur, and the gear opens Options. **Auto**
follows Firefox's light/dark appearance (Settings → General → Website appearance), and switches
live when that changes.

**Adaptive Tab Bar Colour:** Firefox doesn't let one add-on read another add-on's pages, so
add a rule in its settings for the add-on ID `newtab-dashboard@xrdashboard`: `#0D1117` for dark
mode, `#F3F5F8` for light mode. With the dashboard on Auto, both follow the same mode.

Shortcuts: press `P`, or click the eye button, to blur the most-visited sites, ticker, schedule and to-dos.
`←`/`→` (or the ‹ Today › buttons) step the schedule through days, from a week back to 30
days ahead. Keys are ignored while you type in a field or hold Cmd/Ctrl/Alt.

## Permanent install (signed, unlisted)

Release Firefox only installs signed add-ons. Sign as **unlisted** (self-distributed; it
doesn't appear on addons.mozilla.org):

1. Create AMO API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
2. Export them in your shell, or keep them in a local `.env` file in this folder. `.env`
   is git-ignored and listed in `web-ext-config.mjs` `ignoreFiles`, so it is never committed
   or packaged. To save credentials you've already exported, run this in the same shell:

   ```bash
   (umask 077; printf "WEB_EXT_API_KEY='%s'\nWEB_EXT_API_SECRET='%s'\n" "$WEB_EXT_API_KEY" "$WEB_EXT_API_SECRET" > .env)
   ```

3. Sign (`npm run sign` loads `.env` if it exists):

   ```bash
   npm run sign
   ```

   The signed `.xpi` lands in `web-ext-artifacts/` (git-ignored). Mozilla receives the
   package for review. This is why keys must only ever live in `storage.local`.
4. Install it: drag the `.xpi` onto a Firefox window, or `about:addons` → ⚙ →
   *Install Add-on From File…*. Then open Options and enter your keys. Firefox asks once
   whether to keep the new-tab override. Choose *Keep changes*.

### Updating (automatic)

Installed copies update themselves. The manifest's `update_url` points at
[`updates.json`](updates.json) on `main`, which lists each signed `.xpi` (hosted on GitHub
Releases) with its SHA-256 hash. Firefox checks it about once a day; to check now, go to
`about:addons` → ⚙ → *Check for Updates*. Settings and cached data survive updates because the
add-on ID (`newtab-dashboard@xrdashboard`) stays the same.

To publish a new version (needs a clean `main`, `gh` logged in, and AMO credentials):

```bash
npm run release -- 1.0.4
```

This bumps `manifest.json`, runs the tests and lint, pushes `main`, signs with AMO, creates the
GitHub release `v1.0.4` with the `.xpi`, then adds it to `updates.json` and pushes again. AMO
rejects a version it has already signed, so every release needs a new number. Leave out the
version to release the one already in `manifest.json`. If a step fails, fix it and re-run: an
already-signed `.xpi` or existing release is reused.

The `.xpi` and `updates.json` are public. They hold only code: keys and iCal addresses
stay in `storage.local`.

Versions before 1.0.3 don't have `update_url`. Install 1.0.3 or later by hand once, as above.

## Security notes

- All external text (calendar invites, Notion titles, API error messages) is rendered with
  `textContent` / DOM APIs. There is no `innerHTML`, `eval` or `new Function`, and the
  default MV3 CSP is kept.
- Keys and the iCal URL live only in `storage.local`. Nothing is hard-coded or synced.
- `host_permissions` lists exactly the API hosts (Open-Meteo forecast, seasonal, archive and
  geocoding; Google Calendar; Notion; Alpha Vantage). There is no analytics or telemetry.
- The `geolocation` permission lets the new-tab page ask Firefox where the computer is (on a Mac,
  Firefox must be allowed under System Settings → Privacy & Security → Location Services). It
  asks at most every 30 minutes; coordinates are rounded to about 1 km and only sent to Open-Meteo
  for the forecast. The place name is looked up offline. Options → Weather location can set a
  fixed place instead.
- The `topSites` permission (Firefox shows it as "Access browsing history") is used only to read
  the most-visited list locally for the row under the header. Only http(s) links are shown, and
  favicons are used only as inline `data:` images, so the row makes no network requests.
- Notion links are only opened if they point at `notion.com` / `notion.so` / `notion.site` over HTTPS.
