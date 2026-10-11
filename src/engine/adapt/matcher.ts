/**
 * Completed run → planned session matching. Ported from scoreMatch in the
 * Vēlox web app's lib/workout-matcher.ts (the database pass is not ported).
 */
import type { WorkoutType } from "../types/calendar";

// activity workout_type values: "easy" | "long_run" | "workout" | "race" | "moderate"
const TYPE_COMPAT: Record<WorkoutType, string[]> = {
  easy:       ["easy", "moderate"],
  long_run:   ["long_run"],
  tempo:      ["workout", "moderate"],
  interval:   ["workout"],
  threshold:  ["workout", "moderate"],
  recovery:   ["easy"],
  race:       ["race"],
  cross_train: [],
  rest:       [],
};

/** The web app accepted the best candidate only above this score. */
export const MATCH_THRESHOLD = 39;

export type MatchPlanned = { scheduled_date: string; workout_type: WorkoutType; target_distance_km: number | null };
export type MatchActivity = { activity_date: string; distance_km: number | null; workout_type: string };

/** Score a candidate activity against a planned workout. Returns 0–100. */
export function scoreMatch(planned: MatchPlanned, act: MatchActivity): number {
  let score = 0;

  // 1. Date (max 40 pts): a run only counts on the SAME calendar day as the planned session.
  if (act.activity_date === planned.scheduled_date) score += 40;
  else return 0;

  // 2. Workout type (max 30 pts). A run on its planned day completes that slot even
  // if it ran harder or easier than prescribed; type ranks, it does not gate,
  // EXCEPT a non-run slot (rest / cross_train) which a run never completes.
  const compatible = TYPE_COMPAT[planned.workout_type] ?? [];
  if (compatible.length === 0) return 0;
  if (compatible.includes(act.workout_type)) score += 30;

  // 3. Distance proximity (max 30 pts, only with a target).
  if (planned.target_distance_km && act.distance_km) {
    const ratio = act.distance_km / planned.target_distance_km;
    if (ratio >= 0.85 && ratio <= 1.15) score += 30;
    else if (ratio >= 0.7 && ratio <= 1.3) score += 15;
  }

  return score;
}
