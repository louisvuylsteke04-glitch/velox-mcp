/**
 * Shared types for the multi-model race prediction bank.
 *
 * Every model in the bank is a pure function of `ModelInputs`. That is what
 * makes the retroactive time series possible: rebuild the inputs as they stood
 * on some past date, run the same functions, and you have the prediction that
 * date would have produced.
 *
 * A model that lacks what it needs ABSTAINS rather than guessing. Abstention is
 * a first-class result, not an error, and the reason is shown to the user.
 */

/**
 * A performance expressed as "this distance, at race effort, in this time".
 *
 * Most published prediction models take a race result as input. Athletes rarely
 * race, so these are usually derived from training runs by correcting observed
 * pace for the gap between training effort and race effort. See `inputs.ts`.
 */
export type EquivalentEffort = {
  km: number;
  seconds: number;
  /** Where it came from, for display: "21.1 km race", "14.0 km long run (HR 74 %)". */
  label: string;
  /** ISO date of the underlying activity. */
  date: string;
  /**
   * How much this effort should be trusted, 0–1. An actual tagged race scores
   * near 1; an easy run with no HR data and a large effort correction scores low.
   */
  quality: number;
};

/**
 * Everything the bank knows at one point in time. Individual models read only
 * the fields they need and abstain when those are missing.
 */
export type ModelInputs = {
  /** Target race distance in km. */
  targetKm: number;
  /** The date these inputs represent, ISO `YYYY-MM-DD`. */
  asOf: string;
  /**
   * Race-equivalent efforts, best-quality first. Single-effort models use
   * `efforts[0]`; regression models (individualized Riegel, critical speed,
   * velocity decay) fit across the whole list.
   */
  efforts: EquivalentEffort[];
  /** Mean weekly running distance over the trailing 8 weeks, km. */
  weeklyKm: number | null;
  /** Distance-weighted mean training pace over the trailing 8 weeks, sec/km. */
  meanTrainingPaceSecPerKm: number | null;
  /** Chronic training load (Banister CTL), if known. */
  ctl: number | null;
};

export type ModelResult =
  | { status: "ok"; seconds: number }
  | { status: "abstained"; reason: string };

/**
 * A model plus everything a user needs to judge it. The metadata is not
 * decoration: the transparency requirement in issue #34 is served by rendering
 * these fields, so they are part of the type rather than comments.
 */
export type RaceModel = {
  id: string;
  name: string;
  /** Citation for the underlying research or calibration. */
  source: string;
  /** Plain-language description of what the model consumes. */
  inputs: string;
  /** What the model takes for granted. */
  assumptions: string[];
  /** Where it is known to be weak or wrong. */
  limitations: string[];
  /**
   * Distance range in km over which the model is considered valid. Outside it
   * the model abstains rather than extrapolating.
   */
  validKm: [number, number];
  /**
   * Which family the model belongs to. Models in the same family tend to share
   * an input and therefore agree with each other more than they agree with the
   * truth, which matters when reading the spread. See docs/RACE_PREDICTION.md.
   */
  family: "effort-extrapolation" | "physiological" | "training-volume";
  predict: (i: ModelInputs) => ModelResult;
};

/** One model's output, carried alongside the model itself for rendering. */
export type ModelPrediction = {
  model: RaceModel;
  result: ModelResult;
};
