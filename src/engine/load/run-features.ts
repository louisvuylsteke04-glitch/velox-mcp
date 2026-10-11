/**
 * Per-run features: load (TRIMP), HR intensity and the easy / quality / long
 * classification. Ported from `computeFeatures` in the Vēlox web app's
 * lib/strava-sync.ts, unchanged apart from taking a plain run instead of a
 * Strava API object. Stream-derived fields (splits, drift, decoupling) are not
 * computed here; the web app filled them later from streams.
 */
import { banisterCoeffs } from "./training-load";

const RACE_RE = /\b(race|parkrun|5\s*k|10\s*k|half\s*marathon|hm|marathon|ultra|time\s*trial|tt|event)\b/i;
const WORKOUT_RE = /\b(tempo|threshold|interval|intervals|track|fartlek|lactate|speed\s*work|workout|w\/o|repeats?|strides)\b/i;
const LONG_RUN_RE = /\b(long\s*run|lsr|long\s*slow|long\s*easy|lr\b)\b/i;
const EASY_RE = /\b(recovery|shakeout|easy|jog|aerobic|active\s*recover|rest\s*day\s*run)\b/i;

/** One run, in the units Strava returns (metres, seconds, m/s). */
export type RunInput = {
  name?: string | null;
  /** Local start, ISO ("2026-10-10T12:24:30") or a bare date. */
  start_local: string;
  distance_m: number;
  moving_time_s: number;
  elapsed_time_s?: number | null;
  elevation_gain_m?: number | null;
  avg_speed_mps?: number | null;
  average_heartrate?: number | null;
  /** Strava cadence (steps per minute per leg); doubled to spm. */
  average_cadence?: number | null;
  /** Strava workout_type: 1 = race, 3 = workout. */
  workout_type?: number | null;
};

export type RunWorkoutType = "race" | "workout" | "long_run" | "easy" | "moderate";

export type RunFeatures = {
  activity_date: string;
  distance_km: number;
  moving_time_min: number;
  elapsed_time_min: number;
  elevation_gain_m: number;
  average_pace_sec_per_km: number | null;
  average_heartrate_bpm: number | null;
  average_cadence_spm: number | null;
  session_load_basic: number;
  elevation_adjusted_load: number;
  trimp: number | null;
  avg_hr_pct_max: number | null;
  time_in_low_intensity_ratio: number | null;
  time_in_moderate_intensity_ratio: number | null;
  time_in_high_intensity_ratio: number | null;
  workout_type: RunWorkoutType;
  is_long_run: boolean;
  is_easy_run: boolean;
  is_quality_run: boolean;
  efficiency_factor: number | null;
  /** 0.9 with heart rate, 0.5 without (load then comes from the pace proxy). */
  data_quality_score: number;
};

function classifyFromName(name: string): "race" | "workout" | "long_run" | "easy" | null {
  if (RACE_RE.test(name)) return "race";
  if (WORKOUT_RE.test(name)) return "workout";
  if (LONG_RUN_RE.test(name)) return "long_run";
  if (EASY_RE.test(name)) return "easy";
  return null;
}

function estimateZones(avgHrPct: number) {
  if (avgHrPct < 68) return { low: 0.85, mod: 0.12, high: 0.03 };
  if (avgHrPct < 75) return { low: 0.65, mod: 0.30, high: 0.05 };
  if (avgHrPct < 80) return { low: 0.25, mod: 0.60, high: 0.15 };
  if (avgHrPct < 87) return { low: 0.08, mod: 0.50, high: 0.42 };
  return { low: 0.04, mod: 0.20, high: 0.76 };
}

export function computeRunFeatures(
  act: RunInput,
  maxHr: number,
  restHr: number,
  sex: string | null,
): RunFeatures {
  const distance_km = act.distance_m / 1000;
  const moving_time_min = act.moving_time_s / 60;
  const elapsed_time_min = (act.elapsed_time_s ?? act.moving_time_s) / 60;
  const elevation_gain_m = act.elevation_gain_m ?? 0;
  const activity_date = act.start_local.split("T")[0];

  const average_pace_sec_per_km =
    distance_km > 0 ? act.moving_time_s / distance_km : null;

  const average_cadence_spm =
    act.average_cadence != null ? act.average_cadence * 2 : null;

  const average_heartrate_bpm = act.average_heartrate ?? null;

  let trimp: number | null = null;
  let avg_hr_pct_max: number | null = null;
  let time_in_low_intensity_ratio: number | null = null;
  let time_in_moderate_intensity_ratio: number | null = null;
  let time_in_high_intensity_ratio: number | null = null;

  if (average_heartrate_bpm && maxHr > restHr && maxHr > average_heartrate_bpm) {
    const ratio = Math.max(0, (average_heartrate_bpm - restHr) / (maxHr - restHr));
    const { a, b } = banisterCoeffs(sex);
    trimp = moving_time_min * ratio * a * Math.exp(b * ratio);
    avg_hr_pct_max = (average_heartrate_bpm / maxHr) * 100;
    const zones = estimateZones(avg_hr_pct_max);
    time_in_low_intensity_ratio = zones.low;
    time_in_moderate_intensity_ratio = zones.mod;
    time_in_high_intensity_ratio = zones.high;
  } else {
    // No HR: pace-based effort estimate, on the web app's established scale.
    const pace = average_pace_sec_per_km ?? 360;
    const effortFactor = Math.min(1.2, Math.max(0.25, 300 / pace));
    trimp = moving_time_min * effortFactor * 0.55;
  }

  const session_load_basic = trimp ?? moving_time_min * 0.4;
  const elevation_adjusted_load =
    session_load_basic * (1 + (elevation_gain_m / Math.max(distance_km * 1000, 1)) * 0.1);

  const efficiency_factor = average_heartrate_bpm && act.avg_speed_mps
    ? act.avg_speed_mps / average_heartrate_bpm
    : null;

  const wt = act.workout_type ?? 0;
  const nameClassification = classifyFromName(act.name ?? "");
  const is_race = wt === 1 || nameClassification === "race";
  const is_long_run = distance_km >= 15 || moving_time_min >= 75;
  // Races and workouts always count as quality regardless of HR/pace.
  const is_quality_run = is_race
    || wt === 3
    || nameClassification === "workout"
    || (avg_hr_pct_max !== null && avg_hr_pct_max > 85);
  const is_easy_run = !is_quality_run && (
    avg_hr_pct_max !== null
      ? avg_hr_pct_max < 76
      : (average_pace_sec_per_km ?? 0) > 330
  );

  const workout_type: RunWorkoutType =
    wt === 1 ? "race"
      : wt === 3 ? "workout"
        : nameClassification === "race" ? "race"
          : nameClassification === "workout" ? "workout"
            : nameClassification === "long_run" && is_long_run ? "long_run"
              : nameClassification === "easy" ? "easy"
                : is_long_run ? "long_run"
                  : is_easy_run ? "easy"
                    : "moderate";

  const data_quality_score = average_heartrate_bpm ? 0.9 : 0.5;

  return {
    activity_date,
    distance_km,
    moving_time_min,
    elapsed_time_min,
    elevation_gain_m,
    average_pace_sec_per_km,
    average_heartrate_bpm,
    average_cadence_spm,
    session_load_basic,
    elevation_adjusted_load,
    trimp,
    avg_hr_pct_max,
    time_in_low_intensity_ratio,
    time_in_moderate_intensity_ratio,
    time_in_high_intensity_ratio,
    workout_type,
    is_long_run,
    is_easy_run,
    is_quality_run,
    efficiency_factor,
    data_quality_score,
  };
}
