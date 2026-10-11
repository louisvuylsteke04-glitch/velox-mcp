/**
 * Aggregation, spread, and the retroactive time series.
 *
 * AGGREGATION
 * ───────────
 * The central estimate is a WEIGHTED MEDIAN, not a mean.
 *
 * Median rather than mean because one model landing somewhere absurd (a critical
 * speed fit off two badly-spaced efforts, say) should not drag the headline
 * number with it. A mean lets any single model hold the whole estimate hostage.
 *
 * Weighted rather than plain because the bank is not a set of independent
 * opinions. Four models extrapolate from the same equivalent effort; if every
 * model got one vote, that family alone would decide the median regardless of
 * what the physiological and training-volume models said. So each FAMILY carries
 * equal total weight, split among its members. A model's weight is therefore
 * 1 / (number of models from its family that produced a result).
 *
 * SPREAD
 * ──────
 * Reported as the full min-max across models, plus a weighted interquartile band.
 * This is the disagreement between formulas. It is NOT a confidence interval and
 * is never labelled as one: it has no sampling distribution behind it, and
 * because the effort-based models share an input it systematically understates
 * the true error. See docs/RACE_PREDICTION.md.
 */

import { RACE_MODELS, runModel } from "./models";
import { buildInputs } from "./inputs";
import type { ActivityForPrediction } from "../race-predictor";
import type { ModelInputs, ModelPrediction } from "./types";

/** Below this many agreeing models the ensemble is not worth showing. */
export const MIN_MODELS_FOR_ENSEMBLE = 3;

export type Ensemble = {
  asOf: string;
  predictions: ModelPrediction[];
  /** Weighted median across models that produced a result. */
  central: number | null;
  /** Full extent of model disagreement. */
  low: number | null;
  high: number | null;
  /** Weighted 25th–75th percentile: where most models sit. */
  bandLow: number | null;
  bandHigh: number | null;
  /** How many models produced a number, out of how many were asked. */
  answered: number;
  total: number;
  /** (high − low) / central, as a fraction. */
  spreadPct: number | null;
};

type Weighted = { value: number; weight: number };

/** Weighted quantile over values sorted ascending. */
function weightedQuantile(points: Weighted[], q: number): number {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)]?.value ?? NaN;
  const target = total * q;
  let cum = 0;
  for (const p of sorted) {
    cum += p.weight;
    if (cum >= target) return p.value;
  }
  return sorted[sorted.length - 1].value;
}

/** Run the whole bank against one set of inputs. */
export function computeEnsemble(inputs: ModelInputs): Ensemble {
  const predictions: ModelPrediction[] = RACE_MODELS.map((model) => ({
    model,
    result: runModel(model, inputs),
  }));

  const answered = predictions.filter((p) => p.result.status === "ok");

  if (answered.length < MIN_MODELS_FOR_ENSEMBLE) {
    return {
      asOf: inputs.asOf,
      predictions,
      central: null,
      low: null,
      high: null,
      bandLow: null,
      bandHigh: null,
      answered: answered.length,
      total: predictions.length,
      spreadPct: null,
    };
  }

  // Equal weight per family, shared among the family's answering members.
  const familyCounts = new Map<string, number>();
  for (const p of answered) {
    familyCounts.set(p.model.family, (familyCounts.get(p.model.family) ?? 0) + 1);
  }
  const weighted: Weighted[] = answered.map((p) => ({
    value: (p.result as { status: "ok"; seconds: number }).seconds,
    weight: 1 / (familyCounts.get(p.model.family) ?? 1),
  }));

  const values = weighted.map((w) => w.value);
  const central = Math.round(weightedQuantile(weighted, 0.5));
  const low = Math.min(...values);
  const high = Math.max(...values);

  return {
    asOf: inputs.asOf,
    predictions,
    central,
    low,
    high,
    bandLow: Math.round(weightedQuantile(weighted, 0.25)),
    bandHigh: Math.round(weightedQuantile(weighted, 0.75)),
    answered: answered.length,
    total: predictions.length,
    spreadPct: central > 0 ? (high - low) / central : null,
  };
}

// ── Retroactive time series ───────────────────────────────────────────────────

export type SeriesPoint = {
  /** ISO `YYYY-MM-DD` of the checkpoint. */
  date: string;
  central: number | null;
  low: number | null;
  high: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  answered: number;
  /** Per-model seconds, keyed by model id. Absent key means the model abstained. */
  byModel: Record<string, number>;
};

const DAY_MS = 86_400_000;

function toYMD(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Rebuild the ensemble at weekly checkpoints from `startDate` to `endDate`.
 *
 * Nothing is persisted. Because every model is a pure function of the activity
 * history up to a date, the whole history can be recomputed on demand from data
 * already in `activity_features`, which is why this feature needs no new table
 * and why the chart is populated from the first day rather than after months of
 * accumulation.
 *
 * The honest caveat, which the UI states: the series shows what TODAY'S models
 * would have said with the data available then. It is not an archive of what the
 * app actually displayed on those dates.
 */
export function computeSeries(args: {
  activities: ActivityForPrediction[];
  targetKm: number;
  goalType: string;
  startDate: string;
  endDate: string;
  /** Training phase as of each checkpoint; falls back to a constant. */
  phaseFor?: (date: string) => string;
  trainingPhase?: string;
  ctl?: number | null;
  maxPoints?: number;
}): SeriesPoint[] {
  const {
    activities, targetKm, goalType, startDate, endDate,
    phaseFor, trainingPhase = "General", ctl = null, maxPoints = 400,
  } = args;

  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];

  function pointAt(date: string): SeriesPoint {
    const inputs = buildInputs({
      activities,
      asOf: date,
      targetKm,
      goalType,
      trainingPhase: phaseFor ? phaseFor(date) : trainingPhase,
      ctl,
    });
    const e = computeEnsemble(inputs);
    const byModel: Record<string, number> = {};
    for (const p of e.predictions) {
      if (p.result.status === "ok") byModel[p.model.id] = p.result.seconds;
    }
    return {
      date,
      central: e.central,
      low: e.low,
      high: e.high,
      bandLow: e.bandLow,
      bandHigh: e.bandHigh,
      answered: e.answered,
      byModel,
    };
  }

  // Daily rather than weekly. Weekly sampling drew long straight segments
  // between sparse points, which read as a smooth trend that was really an
  // artefact of the sampling. At daily resolution the line shows when the
  // prediction actually moved: flat while nothing new is logged, stepping when
  // a run lands or the trailing volume window slides.
  const totalDays = Math.floor((endMs - startMs) / DAY_MS);
  // Thin only if the range is longer than the cap, so the span is never
  // truncated, only sampled more coarsely.
  const stepDays = Math.max(1, Math.ceil((totalDays + 1) / maxPoints));

  const points: SeriesPoint[] = [];
  for (let d = 0; d <= totalDays; d += stepDays) {
    points.push(pointAt(toYMD(startMs + d * DAY_MS)));
  }

  // Always finish on the end date so the series lines up with today's headline.
  const endYMD = toYMD(endMs);
  if (points[points.length - 1]?.date !== endYMD) points.push(pointAt(endYMD));

  return points;
}
