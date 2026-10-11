# Load calibration for runs without heart rate

**Status:** new in velox-mcp. The Vēlox web app never needed it. Behaviour is otherwise unchanged from the web app.

## The problem

Training load (TRIMP) is best measured from average heart rate. The web app pulled heart rate for every run when it synced Strava, so every run was on the same scale.

Through Claude's Strava connector, `list_activities` returns no heart rate. Heart rate comes from `get_activity_performance`, one call per run. In practice Claude fetches it for the last few runs only.

The web app scored a run without heart rate with a pace proxy, on a scale roughly 3 to 4 times lower than heart-rate TRIMP. Mixing the two makes the most recent week look like a sudden spike.

On real data (43 runs over 16 weeks, heart rate on the last 4):

| | ACWR | Risk | Ramp | Form |
|---|---|---|---|---|
| Without calibration | 2.00 | high | +75% | -18, fatigued |
| With calibration | 1.20 | low | -15% | -8, neutral |

The first row is an artefact. The athlete's last week was lighter than the one before.

## The fix

`src/engine/load/calibrate.ts`. The athlete's own heart-rate runs calibrate the rest onto the heart-rate scale, best signal first:

1. **Strava relative effort** (`summary.relative_effort`). It is heart-rate based and comes with every run in `list_activities` at no extra cost. Load = relative effort × `k_re`, where `k_re` is the median of TRIMP ÷ relative effort over the heart-rate runs.
2. **Pace proxy, calibrated.** Used when relative effort is missing. Load = pace proxy × `k_pace`, the median of TRIMP ÷ pace proxy over the heart-rate runs.
3. **Raw pace proxy.** Used with fewer than 3 heart-rate runs, or a run with no distance. This is exactly the web app's behaviour.

Runs with heart rate are never changed. With heart rate on every run the result is identical to the web app, which the golden parity tests verify.

Medians, not means, so one odd run (heat, a treadmill, a strap glitch) cannot skew the factor.

## What Claude is told

Tool descriptions ask for `relative_effort` on every run and `average_heartrate` for the runs in the last 10 days. `velox_analyze_training` reports how each run was scored (`data.load_methods`) and says so when runs had to fall back to pace alone.

## Not done (yet)

- Strava `best_efforts` (fastest 5K inside a longer run and so on) are not fed to the race models. Treating them as races could overstate fitness, so that needs its own check.
