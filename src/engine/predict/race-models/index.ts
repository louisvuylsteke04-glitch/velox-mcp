/**
 * Multi-model race prediction. See docs/RACE_PREDICTION.md.
 *
 * Behind the MULTI_MODEL_PREDICTION flag. `lib/race-predictor.ts` remains the
 * single source the coaching engine reads; this bank is display-only for now.
 */

export type {
  EquivalentEffort,
  ModelInputs,
  ModelResult,
  ModelPrediction,
  RaceModel,
} from "./types";
export { RACE_MODELS, runModel } from "./models";
export { buildInputs } from "./inputs";
export {
  buildPredictionView,
  seriesWindow,
  isRunRaceGoal,
  type PredictionView,
  type ModelView,
} from "./view";
export {
  computeEnsemble,
  computeSeries,
  MIN_MODELS_FOR_ENSEMBLE,
  type Ensemble,
  type SeriesPoint,
} from "./ensemble";
