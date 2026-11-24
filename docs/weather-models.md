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
| Weather codes, rain amounts, sunrise/sunset | `best_match` |
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

Caveats: one station, ~10 km from the dashboard's Center City point; the 16-day and weekly
tests cover seven months. Rescore if Open-Meteo changes models (HRRR is due to be replaced by RRFS).
