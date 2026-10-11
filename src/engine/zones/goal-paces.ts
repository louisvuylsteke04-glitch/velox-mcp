/**
 * Goal-time → training-pace derivation and goal realism assessment.
 *
 * The plan generator stores a goal race time but historically only printed it
 * into the prompt as text. This module turns that goal time into the concrete
 * training paces a coach would prescribe (easy, threshold, interval, long-run,
 * race pace) and judges whether the goal is realistic given current fitness.
 *
 * Pace derivation reuses the Riegel model already in `race-predictor.ts`:
 * the goal effort is scaled to reference distances (half-marathon ≈ threshold,
 * 3 km ≈ VO2/interval) and easy/long-run paces are offset off threshold.
 */

import {
  raceKmFor,
  riegelScale,
  fmtPredictedTime,
  type RacePrediction,
} from "../predict/race-predictor";

// Easy and long-run paces sit this many seconds/km slower than threshold pace.
const EASY_OFFSET_SEC = 80;
const LONG_RUN_OFFSET_SEC = 60;

// Threshold is duration-based, not distance-based: roughly the pace sustainable
// for ~60 minutes. HM pace ≈ threshold only for ~60-min HM runners; for slower
// runners (HM > 90 min) true threshold is meaningfully faster than HM pace.
const THRESHOLD_DURATION_S = 3600;
const RIEGEL_EXP = 1.06;
const INTERVAL_REF_KM = 3;        // 3 km pace ≈ VO2 / interval pace

export type GoalPaces = {
  goalRacePaceSecPerKm: number;
  easyPaceSecPerKm: number;
  thresholdPaceSecPerKm: number;
  intervalPaceSecPerKm: number;
  longRunPaceSecPerKm: number;
};

export type GoalRealism = {
  verdict: "realistic" | "ambitious" | "unrealistic";
  note: string;
};

/**
 * Derive training paces from a goal finish time. Returns null for fitness goals
 * or unknown distances (no race pace to anchor to).
 *
 * `eventDistanceKm` is the athlete's own race distance, and matters for goal
 * types that do not imply one. An ultra runner's goal time spread over an
 * assumed 80 km instead of their real 50 km makes every pace below it too slow,
 * not just the race pace.
 */
export function derivePacesFromGoal(
  goalTimeSeconds: number,
  goalType: string,
  eventDistanceKm?: number | null,
): GoalPaces | null {
  const raceKm = raceKmFor(goalType, eventDistanceKm);
  if (!raceKm || goalType === "improve_fitness") return null;
  return pacesFromRaceTime(goalTimeSeconds, raceKm);
}

/**
 * Training paces implied by a time over a distance. The same Riegel arithmetic
 * goal paces use, exposed so a real race result can anchor current-fitness paces
 * (#121, PACE_ANCHORS) with exactly the maths a goal time gets.
 */
export function pacesFromRaceTime(goalTimeSeconds: number, raceKm: number): GoalPaces | null {
  if (!Number.isFinite(raceKm) || raceKm <= 0 || !Number.isFinite(goalTimeSeconds) || goalTimeSeconds <= 0) return null;

  const goalRacePace = goalTimeSeconds / raceKm;

  // Distance the athlete would cover in ~60 minutes at this fitness (Riegel,
  // inverted): the pace there is the threshold pace.
  const d60 = raceKm * Math.pow(THRESHOLD_DURATION_S / goalTimeSeconds, 1 / RIEGEL_EXP);
  const thresholdPace = THRESHOLD_DURATION_S / d60;
  const intervalPace  = riegelScale(goalTimeSeconds, raceKm, INTERVAL_REF_KM) / INTERVAL_REF_KM;

  return {
    goalRacePaceSecPerKm: Math.round(goalRacePace),
    thresholdPaceSecPerKm: Math.round(thresholdPace),
    intervalPaceSecPerKm: Math.round(intervalPace),
    easyPaceSecPerKm: Math.round(thresholdPace + EASY_OFFSET_SEC),
    longRunPaceSecPerKm: Math.round(thresholdPace + LONG_RUN_OFFSET_SEC),
  };
}

// Current-fitness training paces, derived from the athlete's MEASURED easy pace
// (their zone2 baseline) rather than a goal time. Percentage offsets scale with
// fitness so they stay sane for both fast and slow runners (a fixed seconds
// offset over-sharpens slow runners). Low precision by nature — always present
// these as current-fitness estimates, never as a goal.
const THRESHOLD_FROM_EASY = 0.90; // threshold ≈ 10% faster than easy
const LONG_FROM_EASY = 0.97;      // long-run ≈ just under easy
const INTERVAL_FROM_EASY = 0.85;  // VO2/interval ≈ 15% faster than easy

/**
 * Build training paces from a measured easy pace (sec/km). Used when there is no
 * confident race prediction (so no goal-derived current paces) and for fitness
 * goals with no race time. `racePaceSecPerKm` is echoed through when a goal race
 * pace exists (for race-specific work only); otherwise it falls back to
 * threshold, which is a sensible cruise pace, never a goal.
 */
export function pacesFromEasyPace(
  easyPaceSecPerKm: number,
  racePaceSecPerKm?: number | null,
): GoalPaces {
  const easy = Math.round(easyPaceSecPerKm);
  const threshold = Math.round(easy * THRESHOLD_FROM_EASY);
  return {
    easyPaceSecPerKm: easy,
    thresholdPaceSecPerKm: threshold,
    longRunPaceSecPerKm: Math.round(easy * LONG_FROM_EASY),
    intervalPaceSecPerKm: Math.round(easy * INTERVAL_FROM_EASY),
    goalRacePaceSecPerKm: racePaceSecPerKm ?? threshold,
  };
}

/**
 * Compare the goal time against a current-fitness prediction.
 *  - goal slower than the predicted time            → realistic
 *  - goal within the fast end of the plausible range → ambitious
 *  - goal faster than the whole plausible range      → unrealistic
 *
 * The plan still trains toward the stated goal; this only drives an honest note
 * in plan_notes (per product decision).
 */
export function assessGoalRealism(input: {
  goalTimeSeconds: number;
  goalType: string;
  prediction: RacePrediction | null;
}): GoalRealism | null {
  const { goalTimeSeconds, goalType, prediction } = input;
  if (!prediction || goalType === "improve_fitness" || !Number.isFinite(goalTimeSeconds) || goalTimeSeconds <= 0) return null;

  const predicted = prediction.predictedSeconds;
  const fastest = prediction.rangeLowSeconds;

  if (goalTimeSeconds >= predicted) {
    return {
      verdict: "realistic",
      note: `Goal of ${fmtPredictedTime(goalTimeSeconds)} is achievable: current fitness projects around ${fmtPredictedTime(predicted)}.`,
    };
  }
  if (goalTimeSeconds >= fastest) {
    return {
      verdict: "ambitious",
      note: `Goal of ${fmtPredictedTime(goalTimeSeconds)} is ambitious but within reach: current fitness projects ${fmtPredictedTime(predicted)}, with a best-case near ${fmtPredictedTime(fastest)}.`,
    };
  }
  const gapPct = Math.round(((fastest - goalTimeSeconds) / fastest) * 100);
  return {
    verdict: "unrealistic",
    note: `Goal of ${fmtPredictedTime(goalTimeSeconds)} is about ${gapPct}% faster than the best-case projection of ${fmtPredictedTime(fastest)} from current fitness. The plan still targets the goal, but a more realistic outcome is closer to ${fmtPredictedTime(predicted)}.`,
  };
}

/** Format a pace (sec/km) as m:ss/km for prompt injection. */
export function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}
