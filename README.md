# New Tab Dashboard (Firefox)

A personal Firefox new-tab page: the next 24 hours of weather and VWRA, Philadelphia weather (16 days and a
monthly outlook), today's Google Calendar, and Notion to-dos matched to free gaps in the day.

Manifest V3, plain HTML/CSS/JS, no remote code. The only third-party code is
[ical.js](https://github.com/kewisch/ical.js) 2.2.1 (MPL-2.0), vendored unmodified in
`vendor/ical.js/`.

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
| Open-Meteo forecast (current, hourly, 16 days) | 30 min | — |
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
   permissions as user-grantable, and the dashboard only asks for its six API hosts.
2. **Google Calendars.** For each calendar: Google Calendar → Settings → the calendar →
   *Integrate calendar* → *Secret address in iCal format*. Add up to 8 with *+ Add calendar*;
   they're merged into one schedule, each with its own accent colour. Recurring events, exceptions, time zones and all-day
   events are expanded locally. Declined invites (matched against the calendar owner in the
   URL) and cancelled events are dropped.
3. **Notion.** Create an *internal* integration with **Read content** only, then share just
   the to-do database with it (database ⋯ → Connections). Paste the token and the database
   URL. Map property names if yours differ: `Name`, `Status` (status/select/checkbox),
   done values (default `Done`), `Due`, `Estimate (min)`, `Related event`, and optionally
   `Priority` (select/status/number). Within each group, and when suggesting to-dos for free
   gaps, higher priority comes first (High/Urgent/P0–P1 before Medium/P2 before Low; other
   option names follow their order in Notion), then the earliest due date.
4. **Alpha Vantage** free API key (VWRA).

Shortcuts: press `P`, or click the eye button, to blur the ticker, schedule and to-dos.
`←`/`→` (or the ‹ Today › buttons) step the schedule through days, from a week back to 30
days ahead. Keys are ignored while you type in a field or hold Cmd/Ctrl/Alt.

## Permanent install (signed, unlisted)

Release Firefox only installs signed add-ons. Sign as **unlisted** (self-distributed; it
doesn't appear on addons.mozilla.org):

1. Create AMO API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
2. Export them in your shell. Never commit them, and keep them out of this folder:

   ```bash
   export WEB_EXT_API_KEY="user:12345:678"
   ```

   ```bash
   export WEB_EXT_API_SECRET="…"
   ```

3. Sign:

   ```bash
   npx web-ext sign --channel=unlisted
   ```

   The signed `.xpi` lands in `web-ext-artifacts/` (git-ignored). Mozilla receives the
   source for review. This is why keys must only ever live in `storage.local`.
4. Install it: drag the `.xpi` onto a Firefox window, or `about:addons` → ⚙ →
   *Install Add-on From File…*. Then open Options and enter your keys. Firefox asks once
   whether to keep the new-tab override. Choose *Keep changes*.

### Updating

1. Bump `version` in `manifest.json`. AMO rejects a version number it has already signed.
2. Run `npm test` and `npx web-ext lint`.
3. Run `npx web-ext sign --channel=unlisted` again and install the new `.xpi` over the old
   one. Settings and cached data survive because the add-on ID
   (`newtab-dashboard@xrdashboard`) stays the same.

## Security notes

- All external text (calendar invites, Notion titles, API error messages) is rendered with
  `textContent` / DOM APIs. There is no `innerHTML`, `eval` or `new Function`, and the
  default MV3 CSP is kept.
- Keys and the iCal URL live only in `storage.local`. Nothing is hard-coded or synced.
- `host_permissions` lists exactly the six API hosts. There is no analytics or telemetry.
- Notion links are only opened if they point at `notion.com` / `notion.so` / `notion.site` over HTTPS.
