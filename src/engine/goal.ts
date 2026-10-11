/**
 * Goal types and training phases. Ported from the web app's
 * lib/types/dashboard.ts, running only, with "today" made explicit.
 */

export type RunGoalType = "5k" | "10k" | "half_marathon" | "marathon" | "ultra" | "improve_fitness";

/** Which goal types the running race predictor and goal-pace maths apply to. */
export const RUN_RACE_TYPES: ReadonlySet<string> = new Set([
  "5k", "10k", "half_marathon", "marathon", "ultra", "improve_fitness",
]);

export type TrainingPhase = "Base" | "Build" | "Peak" | "Taper" | "Race Week" | "General";

const DAY_MS = 86_400_000;

/**
 * Training phase from the race date, as of `nowMs` (epoch milliseconds).
 * (Ported change: the web app read Date.now().)
 */
export function trainingPhase(raceDate: string | null, nowMs: number): TrainingPhase {
  if (!raceDate) return "General";
  const daysLeft = Math.ceil((new Date(raceDate).getTime() - nowMs) / DAY_MS);
  if (daysLeft > 112) return "Base";
  if (daysLeft > 56) return "Build";
  if (daysLeft > 28) return "Peak";
  if (daysLeft > 7) return "Taper";
  return "Race Week";
}

/** "1:52:45" or "43:00". */
export function fmtTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
