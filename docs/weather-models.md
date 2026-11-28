# Weather model choice

Open-Meteo's default `best_match` is just HRRR (first ~48 h) then GFS for Philadelphia.
HRRR runs about 2 °C too cold overnight, so the forecast now requests four models in one call
(`lib/weather.js`, `MODELS`) and merges them per variable. Same host, no new permissions.

| What | Source |
|---|---|
| Temperature (hourly strip, current, 16-day highs/lows) | Average of NBM (`ncep_nbm_conus`) and ECMWF AIFS (`ecmwf_aifs025_single`) through day 11 (IFS + AIFS where NBM is missing) |
| Highs/lows from day 12 (16-day list and Monthly cells, to ~day 42) | Trend estimate: KPHL 2006–2025 normal (`lib/normals.js`, from `scripts/normals.mjs`) shifted by the EC46 weekly temperature anomaly. Shown muted, with `~` in the Monthly view |
| Current temperature / feels-like | `best_match` reading shifted by the blend's offset at that hour (Open-Meteo's `current` block is single-model) |
| Hourly rain chance | NBM (best match serves the same numbers in the US) |
| "Rain from 15:00" summary | Rain chance ≥ 50% only; HRRR's rain amount is used only when there is no chance figure |
| Daily rain chance | Days 1–7: share of the four models with ≥ 1 mm. Days 8–11: NBM. Days 12–16: not shown |
| Weather codes, hourly rain amounts, sunrise/sunset | `best_match` |
| Rain intensity (hourly chip icons, summary) | `best_match` hourly amount: drizzle < 0.5, light < 2.5, moderate < 7.6, heavy ≥ 7.6 mm/h, drawn as four rain icons (named on hover). A spell is named by its start, plus a heavier peak ("Light rain from 06:00, heavy at 17:00") |
| Rain intensity (16-day icons, days 1–7) | Average of the four models' daily totals: light 1–5, moderate 5–15, heavy ≥ 15 mm (drizzle: under 1 mm with rain chance ≥ 50%); a rain code with less shows as cloud. Hover notes "rough" for days 4–7. Later days keep the weather-code icon |
| Wind (hourly chips, 16-day list days 1–7) | `best_match` speed, gusts and direction, requested in m/s (`wind_speed_unit=ms`); gusts ≥ 14 m/s (≈ 50 km/h) flagged amber |
| Weekly outlook | EC46 ensemble mean (unchanged); wetter/drier shown for next week only |
| Monthly outlook | SEAS5 (unchanged; Open-Meteo's only seasonal model; not verifiable — the archive holds one run) |

## How it was scored (Nov 2026)

Observations: Philadelphia airport (KPHL) hourly reports from the Iowa Environmental Mesonet,
2025-11-23 to 2026-11-22; normals from KPHL daily records 1991–2020.

- **Days 1–7:** Open-Meteo Previous Runs API (`_previous_dayN`), one year, ~8,000 hours per lead day.
- **Days 1–15 and rain chance:** Single Runs API, 00Z runs every other day, Apr–Nov 2026 (110 runs).
- **Weekly:** EC46 ensemble-mean Monday runs, Apr–Nov 2026 (28–33 runs per week lead).

Daily high/low mean absolute error, °C:

| Days | NBM + AIFS | AIFS | NBM | IFS | GFS (`best_match`) |
|---|---|---|---|---|---|
| 1–3 | 0.99 | 1.01 | 1.16 | 1.44 | 1.65 |
| 4–7 | 1.47 | 1.52 | 1.76 | 2.01 | 2.10 |
| 8–11 | 2.09 | 2.50 | 2.44 | 3.04 | 3.19 |
| 12–15 | IFS + AIFS 3.12 | 3.53 | — | 3.82 | 3.75 |

Hourly temperature error over the next 24 h: NBM + AIFS 1.15 °C, `best_match` 2.06 °C.

Past day 11 no daily forecast beats the plain normal, so the dashboard shows the trend estimate.
EC46 ensemble-mean daily highs/lows, 77 runs Apr–Nov 2026, against 2006–2025 normals (°C):

| Days | EC46 as served | EC46 bias-corrected | Normal | Normal + EC46 weekly anomaly |
|---|---|---|---|---|
| 12–15 | 3.17 | 2.87 | 2.93 | ~2.65 |
| 16–21 | 2.95 | 2.70 | 2.75 | 2.62 |
| 22–28 | 2.88 | 2.65 | 2.70 | 2.57 |
| 29–42 | ~2.92 | ~2.68 | ~2.72 | ~2.59 |

(EC46 daily values run ~1.7 °C cold here; they come from 6-hourly output.) Some of the gain in
weeks 4–6 is likely the warming trend beyond the 2006–2025 normals rather than forecast skill.

Rain, Brier skill vs the usual odds (0 = no better than always quoting them; higher is better):

| | Days 1–3 | 4–7 | 8–11 | 12–15 |
|---|---|---|---|---|
| Model vote (≥ 1 mm) | 0.63 | 0.28 | −0.03 | −0.28 |
| NBM rain chance | 0.44 | 0.20 | −0.04 | — |
| Best single yes/no | 0.47 (AIFS) | 0.06 | < −0.5 | < −0.8 |

Next-36-hour rain in 3-hour blocks: NBM chance 0.44, HRRR/GFS yes/no 0.14.

EC46 weekly temperature anomaly, correlation with what happened: week 1 0.92, week 2 0.60
(better than any 16-day model's week 2), week 3 0.35, weeks 4–6 0.24 → 0.02 (mostly the
warming trend vs 1991–2020). Wetter/drier: week 1 0.67, week 2 0.27, weeks 3–6 ≤ 0.

Away from Philadelphia (the location is detected or set in Options), the same models are requested.
NBM is US-only, so outside the US temperature is IFS + AIFS and the rain chance is best match's;
none of that was scored there. The long-range estimate uses normals from Open-Meteo's ERA5 archive
(2006–2025) instead of the station table. At KPHL, ERA5 normals run 0.5 °C cool on highs and 0.9 °C
on lows; ERA5 normal + EC46 anomaly scored 2.71 °C for weeks 2–6, against 2.61 with station normals
and 2.77 for the station normal alone. A detected place's normals (~170 KB) are fetched only after
it has been current for 12 h, and the last 10 places are kept and reused within 50 km (about two
ERA5 grid cells), so travelling does not fetch at every stop. Until then, days 12+ show the models.

Caveats: one station, ~10 km from the dashboard's Center City point; the 16-day and weekly
tests cover seven months. Rescore if Open-Meteo changes models (HRRR is due to be replaced by RRFS).

## Wind and rain intensity (scored Nov 2026)

Same observations (KPHL METAR wind is a 2-minute mean; gusts are only reported when present, so
observed daily peaks are undercounted). 00Z Single Runs every fourth day for wind (55 runs),
every other day for rain (110 runs), Apr–Nov 2026.

Scored in km/h (shown in m/s: divide by 3.6). Hourly wind speed mean absolute error, km/h
(always forecasting the mean: 6.6):

| Days | GFS (`best_match`) | IFS | AIFS | NBM | IFS + AIFS |
|---|---|---|---|---|---|
| 1–3 | 4.9 | 5.0 | 5.1 | 6.1 | 4.9 |
| 4–7 | 5.7 | 5.9 | 6.0 | 6.7 | 5.7 |
| 8–11 | 6.7 | 7.3 | 7.0 | 7.2 | 6.8 |
| 12–15 | 6.8 | 7.4 | 7.3 | – | 7.0 |

Daily maximum wind: GFS 7.1 / 8.3 / 9.3 km/h for days 1–3 / 4–7 / 8–11, the best of the four.
Every model reads low at the airport (GFS by about 3 km/h, NBM by 5); not corrected, since the
city is less exposed than the airfield. Gusts ≥ 50 km/h: GFS caught half of such days in days 1–3
(43% false alarms), about a third by days 8–11; AIFS has no gusts. Past day 7 no model beat the
mean, so wind is shown for 7 days.

Daily rain total by category (dry < 1, light < 5, moderate < 15, heavy ≥ 15 mm). Exact-category
scores sit near the 72% that "always dry" gets, but within one category the models are right
93–97% of the time for days 1–3. Heavy days (25–36 in each lead band), hit rate / false alarms:

| Days | Four-model average | NBM + AIFS | NBM | IFS | GFS |
|---|---|---|---|---|---|
| 1–3 | 0.60 / 0.21 | 0.56 / 0.36 | 0.56 / 0.36 | 0.56 / 0.48 | 0.52 / 0.48 |
| 4–7 | 0.11 / 0.56 | 0.03 / 0.83 | 0.11 / 0.60 | 0.25 / 0.69 | 0.22 / 0.58 |
| 8–11 | 0.00 / 1.00 | 0.03 / 0.83 | 0.03 / 0.80 | 0.14 / 0.80 | 0.06 / 0.87 |

So daily intensity is shown for days 1–7, muted from day 4. Hourly downpours (≥ 7.6 mm in an
hour) are the weakest part: of 19 such days in the first two days of each run, GFS caught 6
(62% false alarms) and IFS 4. Treat "heavy at 17:00" as "heavy rain likely that afternoon".

