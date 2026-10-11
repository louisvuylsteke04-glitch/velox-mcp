/**
 * Selects the pace-anchor evidence from the athlete's runs and race results
 * exactly as the Vēlox web app's readAnchorData queried it: race results and
 * race-tagged runs from the last ANCHOR_WINDOW_DAYS (newest first, at most 20),
 * and the 21 most recent runs for the predictor.
 */
import type { ActivityForPrediction } from "../predict/race-predictor";
import type { RunFeatures } from "../load/run-features";
import { ANCHOR_WINDOW_DAYS, type AnchorBenchmark, type AnchorRaceRow } from "./pace-anchor";
import type { AnchorData } from "./profile";

const DAY_MS = 86_400_000;

export function anchorDataFrom(args: {
  runs: Pick<RunFeatures, "activity_date" | "distance_km" | "moving_time_min" | "average_pace_sec_per_km" | "avg_hr_pct_max" | "workout_type" | "is_easy_run" | "is_long_run" | "is_quality_run">[];
  races: AnchorRaceRow[];
  goal: AnchorData["goal"];
  benchmarks?: AnchorBenchmark[];
  nowMs: number;
}): AnchorData {
  const since = new Date(args.nowMs - ANCHOR_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const newestFirst = [...args.runs].sort((a, b) => b.activity_date.localeCompare(a.activity_date));
  return {
    races: args.races
      .filter((r) => r.race_date >= since)
      .sort((a, b) => b.race_date.localeCompare(a.race_date))
      .slice(0, 20),
    raceActivities: newestFirst
      .filter((r) => r.workout_type === "race" && r.activity_date >= since)
      .slice(0, 20)
      .map((r) => ({ activity_date: r.activity_date, distance_km: r.distance_km, moving_time_min: r.moving_time_min })),
    goal: args.goal,
    predictionRuns: newestFirst.slice(0, 21).map((r): ActivityForPrediction => ({
      activity_date: r.activity_date, distance_km: r.distance_km, moving_time_min: r.moving_time_min,
      average_pace_sec_per_km: r.average_pace_sec_per_km, avg_hr_pct_max: r.avg_hr_pct_max,
      workout_type: r.workout_type, is_easy_run: r.is_easy_run, is_long_run: r.is_long_run, is_quality_run: r.is_quality_run,
    })),
    benchmarks: args.benchmarks ?? [],
  };
}
