/**
 * Layer A: turning training history into model inputs.
 *
 * Almost every published race-prediction model expects a RACE result. Athletes
 * rarely race, so the bank would abstain on nearly everyone if we fed it only
 * genuine races. Instead each training run is converted into the race-equivalent
 * effort it implies, by correcting observed pace for the gap between training
 * intensity and race intensity.
 *
 * That correction is the single largest source of error in the whole system,
 * and it is shared by every effort-based model. It is the reason the spread
 * between those models understates true uncertainty: they disagree about how to
 * extrapolate, but they agree about where they are extrapolating from. See
 * docs/RACE_PREDICTION.md.
 *
 * Everything here is a pure function of (activities, asOf), which is what lets
 * the same code rebuild the inputs as they stood on any past date.
 */

import {
  effortCorrection,
  RACE_HR_PCT,
  type ActivityForPrediction,
} from "../race-predictor";
import type { EquivalentEffort, ModelInputs } from "./types";

/** How far back efforts are gathered from, in days. */
const EFFORT_WINDOW_DAYS = 112; // 16 weeks
/** Tanda specifies the 8 weeks before the race for volume and pace. */
const VOLUME_WINDOW_DAYS = 56;
/** Cap on efforts handed to the regression models. */
const MAX_EFFORTS = 40;

const DAY_MS = 86_400_000;

function daysBetween(fromISO: string, toISO: string): number {
  return (new Date(toISO).getTime() - new Date(fromISO).getTime()) / DAY_MS;
}

/** Distance, time and pace sanity, mirroring the filters in race-predictor.ts. */
function usableRun(a: ActivityForPrediction): { dist: number; pace: number } | null {
  const dist = a.distance_km;
  const tmin = a.moving_time_min;
  if (!dist || dist < 3 || !tmin || tmin < 10) return null;
  const pace = a.average_pace_sec_per_km ?? (tmin * 60) / dist;
  if (!pace || pace < 150 || pace > 1200) return null; // 2:30–20:00 per km
  return { dist, pace };
}

function paceFmt(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

/**
 * Build the bank's inputs as they stood on `asOf`.
 *
 * Only activities dated on or before `asOf` are considered, which is what makes
 * the historical series honest rather than a curve drawn with hindsight.
 */
export function buildInputs(args: {
  activities: ActivityForPrediction[];
  asOf: string;
  targetKm: number;
  goalType: string;
  trainingPhase: string;
  ctl: number | null;
}): ModelInputs {
  const { activities, asOf, targetKm, goalType, trainingPhase, ctl } = args;
  const raceHrPct = RACE_HR_PCT[goalType] ?? 85;

  const efforts: EquivalentEffort[] = [];
  let volumeKm = 0;
  let volumeSeconds = 0;

  for (const a of activities) {
    if (!a.activity_date) continue;
    const age = daysBetween(a.activity_date, asOf);
    if (age < 0 || age > EFFORT_WINDOW_DAYS) continue;

    const run = usableRun(a);
    if (!run) continue;
    const { dist, pace } = run;

    // Trailing-8-week aggregates for the training-volume models. Total time over
    // total distance, so a long slow run counts for more than a short one.
    if (age <= VOLUME_WINDOW_DAYS) {
      volumeKm += dist;
      volumeSeconds += pace * dist;
    }

    const hr = a.avg_hr_pct_max;
    const hasHr = hr != null && hr > 40;
    const correction = effortCorrection(
      hr,
      a.workout_type,
      a.is_quality_run,
      a.is_long_run,
      trainingPhase,
      raceHrPct,
    );

    // The effort this run implies, held at its own distance. Models scale it.
    const equivalentSeconds = pace * correction * dist;

    // Quality is trust in the effort estimate, not trust in the athlete.
    // A tagged race needs no correction at all and is believed almost fully.
    const base =
      a.workout_type === "race" ? 1.0
      : a.is_quality_run || a.workout_type === "workout" ? 0.75
      : a.is_long_run || a.workout_type === "long_run" ? 0.65
      : 0.5;
    // Without HR the correction is a table lookup rather than a measurement.
    const hrFactor = hasHr ? 1.0 : 0.65;
    // A large correction means the run was far from race effort, so the
    // extrapolation is doing more of the work and deserves less trust.
    const stretchFactor = 1 - Math.min(0.35, Math.abs(1 - correction));
    const recencyFactor = Math.exp(-age / 42);
    const quality = base * hrFactor * stretchFactor * recencyFactor;

    const sessionDesc =
      a.workout_type === "race" ? "race"
      : a.is_quality_run ? "quality session"
      : a.is_long_run ? "long run"
      : a.is_easy_run ? "easy run"
      : "run";

    efforts.push({
      km: dist,
      seconds: equivalentSeconds,
      label: `${dist.toFixed(1)} km ${sessionDesc} at ${paceFmt(pace)}${hasHr ? ` (HR ${hr!.toFixed(0)} %)` : ""}`,
      date: a.activity_date,
      quality,
    });
  }

  efforts.sort((a, b) => b.quality - a.quality);

  const weeks = VOLUME_WINDOW_DAYS / 7;
  return {
    targetKm,
    asOf,
    efforts: efforts.slice(0, MAX_EFFORTS),
    weeklyKm: volumeKm > 0 ? volumeKm / weeks : null,
    meanTrainingPaceSecPerKm: volumeKm > 0 ? volumeSeconds / volumeKm : null,
    ctl,
  };
}
