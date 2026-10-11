/**
 * Assembling the serialisable payload the calendar UI renders.
 *
 * `RaceModel` carries a function, so it cannot cross the server/client boundary.
 * Everything here is plain data: the model metadata a user needs in order to
 * judge a number, flattened alongside that number.
 */

import { raceKmFor, type ActivityForPrediction } from "../race-predictor";
import { RUN_RACE_TYPES } from "../../goal";
import { buildInputs } from "./inputs";
import { computeEnsemble, computeSeries, type SeriesPoint } from "./ensemble";

/**
 * Whether the model bank applies to a goal.
 *
 * Every model here is a RUNNING model: Riegel, Cameron, Daniels, Tanda and the
 * rest are all fitted to running performances, and the effort estimation feeds
 * on running pace and running HR. None of it transfers to a bike or swim event,
 * and a triathlon's run leg cannot be predicted from run training alone because
 * it is run on legs that have already ridden.
 *
 * Gate on the canonical RUN_RACE_TYPES rather than on `RACE_KM[goalType]`
 * returning something. That lookup happens to exclude the multisport types
 * today, so the panel is already hidden from them, but only by coincidence of
 * which keys the table holds. Adding `triathlon_half: 21.0975` to RACE_KM is an
 * entirely reasonable thing for someone to do later, and it would silently start
 * showing standalone half-marathon predictions to triathletes. This makes the
 * intent explicit so that cannot happen.
 *
 * `improve_fitness` counts as a run goal elsewhere but is excluded here: there
 * is no race distance to predict.
 */
export function isRunRaceGoal(goalType: string | null | undefined): boolean {
  return !!goalType && RUN_RACE_TYPES.has(goalType) && goalType !== "improve_fitness";
}

export type ModelView = {
  id: string;
  name: string;
  source: string;
  inputs: string;
  assumptions: string[];
  limitations: string[];
  family: "effort-extrapolation" | "physiological" | "training-volume";
  /** Predicted seconds, or null when the model abstained. */
  seconds: number | null;
  /** Why it abstained, when it did. */
  abstainReason: string | null;
};

export type PredictionView = {
  targetKm: number;
  goalLabel: string;
  central: number | null;
  low: number | null;
  high: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  answered: number;
  total: number;
  spreadPct: number | null;
  models: ModelView[];
  series: SeriesPoint[];
  /** The best single effort behind the effort-based models, for display. */
  primaryEffort: string | null;
};

/** How far back the series reaches by default. */
const DEFAULT_SERIES_WEEKS = 26;
/** Ceiling, so a long-standing account does not draw a two-year chart. */
const MAX_SERIES_WEEKS = 52;
/** Effort lookback, so the first checkpoint is not artificially empty. */
export const SERIES_PREROLL_DAYS = 112;

const DAY_MS = 86_400_000;

function toYMD(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Training phase as of an arbitrary date. Mirrors `trainingPhase()` in
 * lib/types/dashboard.ts, which reads Date.now() and so cannot be replayed.
 */
function phaseAsOf(raceDate: string | null, asOf: string): string {
  if (!raceDate) return "General";
  const daysLeft = Math.ceil((new Date(raceDate).getTime() - new Date(asOf).getTime()) / DAY_MS);
  if (daysLeft > 112) return "Base";
  if (daysLeft > 56) return "Build";
  if (daysLeft > 28) return "Peak";
  if (daysLeft > 7) return "Taper";
  return "Race Week";
}

/**
 * The earliest date the series should cover, and how far back to fetch for it.
 *
 * The block anchor (plan start, else training start) is a FLOOR on how far back
 * to look, never a ceiling. Anchoring the series to plan start alone collapses
 * the chart to two checkpoints for anyone whose plan was generated last week,
 * even when they have months of activity history sitting in the database that
 * can be replayed. Since predictions are recomputed rather than accumulated,
 * there is no reason to throw that history away: take whichever of the anchor
 * and the default lookback reaches further back.
 */
export function seriesWindow(args: {
  planStartDate: string | null;
  trainingStartDate: string | null;
  today: string;
}): { start: string; fetchFrom: string } {
  const todayMs = new Date(args.today).getTime();
  const anchor = args.planStartDate ?? args.trainingStartDate;
  const anchorMs = anchor ? new Date(anchor).getTime() : NaN;
  const defaultMs = todayMs - DEFAULT_SERIES_WEEKS * 7 * DAY_MS;
  const floorMs = todayMs - MAX_SERIES_WEEKS * 7 * DAY_MS;

  const candidateMs = Number.isFinite(anchorMs)
    ? Math.min(anchorMs, defaultMs)
    : defaultMs;
  // Never start in the future, never reach past the ceiling.
  const startMs = Math.min(todayMs, Math.max(candidateMs, floorMs));
  return {
    start: toYMD(startMs),
    fetchFrom: toYMD(startMs - SERIES_PREROLL_DAYS * DAY_MS),
  };
}

export function buildPredictionView(args: {
  activities: ActivityForPrediction[];
  goalType: string;
  goalLabel: string;
  raceDate: string | null;
  planStartDate: string | null;
  trainingStartDate: string | null;
  today: string;
  ctl?: number | null;
  /** The athlete's own race distance, for goal types that do not imply one. */
  eventDistanceKm?: number | null;
}): PredictionView | null {
  const { activities, goalType, goalLabel, raceDate, today, ctl = null } = args;

  if (!isRunRaceGoal(goalType)) return null;
  const targetKm = raceKmFor(goalType, args.eventDistanceKm);
  if (!targetKm) return null;

  const { start } = seriesWindow({
    planStartDate: args.planStartDate,
    trainingStartDate: args.trainingStartDate,
    today,
  });

  const nowInputs = buildInputs({
    activities,
    asOf: today,
    targetKm,
    goalType,
    trainingPhase: phaseAsOf(raceDate, today),
    ctl,
  });
  const now = computeEnsemble(nowInputs);

  const fullSeries = computeSeries({
    activities,
    targetKm,
    goalType,
    startDate: start,
    endDate: today,
    phaseFor: (d) => phaseAsOf(raceDate, d),
    ctl,
  });

  // Drop leading checkpoints from before there was enough history to predict
  // anything, so an athlete with ten weeks of data gets a ten-week chart rather
  // than a twenty-six-week one that is blank for the first sixteen.
  const firstAnswered = fullSeries.findIndex((p) => p.central != null);
  const series = firstAnswered > 0 ? fullSeries.slice(firstAnswered) : fullSeries;

  const models: ModelView[] = now.predictions.map(({ model, result }) => ({
    id: model.id,
    name: model.name,
    source: model.source,
    inputs: model.inputs,
    assumptions: model.assumptions,
    limitations: model.limitations,
    family: model.family,
    seconds: result.status === "ok" ? result.seconds : null,
    abstainReason: result.status === "abstained" ? result.reason : null,
  }));

  return {
    targetKm,
    goalLabel,
    central: now.central,
    low: now.low,
    high: now.high,
    bandLow: now.bandLow,
    bandHigh: now.bandHigh,
    answered: now.answered,
    total: now.total,
    spreadPct: now.spreadPct,
    models,
    series,
    primaryEffort: nowInputs.efforts[0]?.label ?? null,
  };
}
