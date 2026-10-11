/**
 * The model bank.
 *
 * Ten published or in-house race-prediction models, each implemented as a pure
 * function so the same code can be replayed at any past date. Coefficients are
 * transcribed from the cited sources; see docs/RACE_PREDICTION.md for the full
 * methodology write-up and scripts/race-model-tests.ts for the checks against
 * published reference values.
 *
 * Models are grouped into three families, which matters for reading the spread:
 *
 *   effort-extrapolation  Take one or more race-equivalent efforts and scale
 *                         them to the target distance. They share an input, so
 *                         they agree with each other more than they agree with
 *                         reality.
 *   physiological         Convert an effort into an oxygen-cost / capacity
 *                         estimate, then back to a sustainable target pace.
 *   training-volume       Read training load and volume directly. Independent
 *                         of the effort estimate, so genuine disagreement with
 *                         the other two families is informative.
 */

import { ctlToMarathonSecs, volumeToMarathonSecs, riegelScale } from "../race-predictor";
import type { ModelInputs, ModelResult, RaceModel, EquivalentEffort } from "./types";

// ── Numeric helpers ───────────────────────────────────────────────────────────

const ok = (seconds: number): ModelResult => ({ status: "ok", seconds: Math.round(seconds) });
const no = (reason: string): ModelResult => ({ status: "abstained", reason });

/** Efforts usable for regression: distinct distances, sane values. */
function regressionSet(efforts: EquivalentEffort[]): EquivalentEffort[] {
  const byKm = new Map<number, EquivalentEffort>();
  for (const e of efforts) {
    if (e.km <= 0 || e.seconds <= 0) continue;
    // Bucket to 0.5 km so twenty 10 km runs do not masquerade as twenty points.
    const bucket = Math.round(e.km * 2) / 2;
    const seen = byKm.get(bucket);
    // Within a bucket keep the fastest: it is the closest to a true race effort.
    if (!seen || e.seconds < seen.seconds) byKm.set(bucket, e);
  }
  return [...byKm.values()].sort((a, b) => a.km - b.km);
}

/** Ordinary least squares on (x, y). Returns null if x has no spread. */
function ols(pts: Array<[number, number]>): { slope: number; intercept: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  if (den < 1e-9) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

// ── Daniels–Gilbert VDOT primitives ───────────────────────────────────────────
// Daniels JT, Gilbert J. "Oxygen Power: Performance Tables for Distance
// Runners" (1979). Velocity in m/min, duration in minutes.

/** Oxygen cost of running at velocity v (m/min), ml/kg/min. */
export function danielsOxygenCost(vMetresPerMin: number): number {
  return -4.6 + 0.182258 * vMetresPerMin + 0.000104 * vMetresPerMin ** 2;
}

/** Fraction of VO2max sustainable for a effort of `minutes` duration. */
export function danielsPercentMax(minutes: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * minutes) +
    0.2989558 * Math.exp(-0.1932605 * minutes)
  );
}

/** VDOT ("pseudo-VO2max") implied by covering `km` in `seconds`. */
export function vdotFromEffort(km: number, seconds: number): number {
  const minutes = seconds / 60;
  const v = (km * 1000) / minutes;
  return danielsOxygenCost(v) / danielsPercentMax(minutes);
}

/**
 * Invert Daniels: the time over `km` that exactly consumes `vdot`.
 *
 * g(t) = oxygenCost(distance / t) − vdot × percentMax(t) is monotonically
 * decreasing in t, so a bisection is both safe and sufficient here.
 */
export function timeFromVdot(km: number, vdot: number): number {
  const metres = km * 1000;
  const g = (minutes: number) =>
    danielsOxygenCost(metres / minutes) - vdot * danielsPercentMax(minutes);
  let lo = 1;
  let hi = 1500;
  if (g(lo) < 0 || g(hi) > 0) return NaN;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}

// ── The models ────────────────────────────────────────────────────────────────

const riegelFixed: RaceModel = {
  id: "riegel",
  name: "Riegel",
  source: "Riegel PS, 'Athletic Records and Human Endurance', American Scientist 69(3), 1981.",
  inputs: "One race-equivalent effort.",
  assumptions: [
    "Time scales with distance as a power law with a fixed exponent of 1.06.",
    "The athlete is equally well trained for both distances.",
  ],
  limitations: [
    "Known to under-predict marathon time. Vickers & Vertosick (2016) found it well calibrated up to the half marathon but at least 10 minutes too fast for half of recreational marathoners.",
    "Ignores training volume entirely, so it cannot tell a well-prepared marathoner from an under-prepared one.",
  ],
  validKm: [1.5, 100],
  family: "effort-extrapolation",
  predict: (i) => {
    const e = i.efforts[0];
    if (!e) return no("No race-equivalent effort available.");
    return ok(riegelScale(e.seconds, e.km, i.targetKm));
  },
};

const riegelIndividual: RaceModel = {
  id: "riegel-individual",
  name: "Riegel, individualised exponent",
  source:
    "Riegel's power law with the exponent fitted per athlete rather than fixed, motivated by Vickers AJ & Vertosick EA, BMC Sports Sci Med Rehabil 8:26, 2016, which showed the fixed 1.06 exponent misfits recreational marathoners.",
  inputs: "Three or more efforts spanning a range of distances.",
  assumptions: [
    "The athlete's own endurance decay is a power law, and their recent efforts reveal its exponent.",
    "Efforts across the range were run at comparable relative effort.",
  ],
  limitations: [
    "Needs a real spread of distances. Training that is all 10 km runs gives no signal and the model abstains.",
    "A single mis-estimated effort can tilt the fitted exponent, so it is clamped to a physiologically plausible 1.01–1.20.",
  ],
  validKm: [1.5, 100],
  family: "effort-extrapolation",
  predict: (i) => {
    const set = regressionSet(i.efforts);
    if (set.length < 3) return no("Needs at least 3 efforts at different distances.");
    const spread = set[set.length - 1].km / set[0].km;
    if (spread < 1.8) return no("Efforts are too similar in distance to fit an exponent.");
    const fit = ols(set.map((e) => [Math.log(e.km), Math.log(e.seconds)]));
    if (!fit) return no("Could not fit an exponent to the available efforts.");
    const exponent = Math.max(1.01, Math.min(1.2, fit.slope));
    const ref = i.efforts[0];
    return ok(ref.seconds * Math.pow(i.targetKm / ref.km, exponent));
  },
};

const cameron: RaceModel = {
  id: "cameron",
  name: "Cameron",
  source: "Cameron D, race prediction formula, 1998.",
  inputs: "One race-equivalent effort.",
  assumptions: [
    "Endurance decay is distance-specific rather than a single fixed exponent.",
    "Fitted against well-trained runners' performances from 800 m to the marathon.",
  ],
  limitations: [
    "Empirical curve fit with no physiological mechanism behind it.",
    "Calibrated on competitive runners, so it can flatter slower recreational athletes.",
  ],
  validKm: [0.8, 42.195],
  family: "effort-extrapolation",
  predict: (i) => {
    const e = i.efforts[0];
    if (!e) return no("No race-equivalent effort available.");
    // f(x) with x in metres.
    const f = (x: number) => 13.49681 - 0.000030363 * x + 835.7114 / Math.pow(x, 0.7905);
    const d1 = e.km * 1000;
    const d2 = i.targetKm * 1000;
    return ok(e.seconds * (d2 / d1) * (f(d1) / f(d2)));
  },
};

const danielsVdot: RaceModel = {
  id: "daniels-vdot",
  name: "Daniels VDOT",
  source: "Daniels JT & Gilbert J, 'Oxygen Power: Performance Tables for Distance Runners', 1979.",
  inputs: "One race-equivalent effort.",
  assumptions: [
    "A single 'pseudo-VO2max' captures both aerobic capacity and running economy.",
    "The fraction of VO2max sustainable falls with duration along a fixed double-exponential curve.",
  ],
  limitations: [
    "The economy curve is fitted to trained runners; athletes with unusual economy are mis-scored.",
    "The sustainable-fraction curve is population-average and does not know this athlete's endurance.",
    "Daniels' published race-equivalency tables carry a marathon-specific correction that these equations do not, so marathon predictions here run roughly a VDOT point optimistic against those tables.",
  ],
  validKm: [1.5, 42.195],
  family: "physiological",
  predict: (i) => {
    const e = i.efforts[0];
    if (!e) return no("No race-equivalent effort available.");
    const vdot = vdotFromEffort(e.km, e.seconds);
    if (!Number.isFinite(vdot) || vdot < 20 || vdot > 90) {
      return no("Effort implies an implausible VDOT.");
    }
    const secs = timeFromVdot(i.targetKm, vdot);
    if (!Number.isFinite(secs)) return no("Could not invert VDOT for this distance.");
    return ok(secs);
  },
};

const acsm: RaceModel = {
  id: "acsm",
  name: "ACSM metabolic equation",
  source: "ACSM's Guidelines for Exercise Testing and Prescription, running equation VO2 = 0.2·v + 3.5.",
  inputs: "One race-equivalent effort, via an estimated aerobic capacity.",
  assumptions: [
    "Oxygen cost rises linearly with speed, i.e. running economy is constant across paces.",
    "The sustainable fraction of capacity falls with duration as Daniels describes.",
  ],
  limitations: [
    "The linear oxygen cost understates the true cost at fast paces, where the real relationship curves upward.",
    "Shares its input and its sustainable-fraction curve with the Daniels model, so the two agree by construction. Treat them as one voice, not two.",
  ],
  validKm: [1.5, 42.195],
  family: "physiological",
  predict: (i) => {
    const e = i.efforts[0];
    if (!e) return no("No race-equivalent effort available.");
    const minutes = e.seconds / 60;
    const v = (e.km * 1000) / minutes;
    const capacity = (0.2 * v + 3.5) / danielsPercentMax(minutes);
    if (!Number.isFinite(capacity) || capacity < 20 || capacity > 90) {
      return no("Effort implies an implausible aerobic capacity.");
    }
    // Solve 0.2·(metres/t) + 3.5 = capacity × percentMax(t) for t.
    const metres = i.targetKm * 1000;
    const g = (t: number) => 0.2 * (metres / t) + 3.5 - capacity * danielsPercentMax(t);
    let lo = 1;
    let hi = 1500;
    if (g(lo) < 0 || g(hi) > 0) return no("Could not solve the metabolic equation for this distance.");
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2;
      if (g(mid) > 0) lo = mid;
      else hi = mid;
    }
    return ok(((lo + hi) / 2) * 60);
  },
};

const criticalSpeed: RaceModel = {
  id: "critical-speed",
  name: "Critical speed",
  source:
    "Monod H & Scherrer J, Ergonomics 8:329, 1965; Jones AM & Vanhatalo A, Sports Med 47:65, 2017. Two-parameter model d = CS·t + D'.",
  inputs: "Two or more efforts of clearly different duration.",
  assumptions: [
    "Distance covered is linear in time above critical speed: a sustainable speed plus a finite reserve D'.",
    "Both parameters are stable over the fitting window.",
  ],
  limitations: [
    "Derived from efforts of roughly 3–15 minutes. Extrapolating it to the half marathon and beyond over-predicts, because it models no fuel limit, so it abstains above 21.1 km.",
    "Very sensitive to the duration spread of the input efforts.",
  ],
  validKm: [1.5, 21.0975],
  family: "physiological",
  predict: (i) => {
    if (i.targetKm > 21.0975) {
      return no("Critical speed is not valid beyond the half marathon; it models no fuel limit.");
    }
    const set = regressionSet(i.efforts);
    if (set.length < 2) return no("Needs at least 2 efforts of different duration.");
    const durationSpread = set[set.length - 1].seconds / set[0].seconds;
    if (durationSpread < 1.5) return no("Efforts are too similar in duration to fit critical speed.");
    // d = CS·t + D'  →  regress metres on seconds.
    const fit = ols(set.map((e) => [e.seconds, e.km * 1000]));
    if (!fit) return no("Could not fit the critical speed model.");
    const cs = fit.slope;
    const dPrime = fit.intercept;
    if (cs <= 0.5) return no("Fitted critical speed is implausible.");
    if (dPrime < 0) return no("Fitted anaerobic reserve is negative; the efforts do not fit the model.");
    const metres = i.targetKm * 1000;
    if (dPrime >= metres) return no("Fitted reserve exceeds the race distance.");
    return ok((metres - dPrime) / cs);
  },
};

const velocityDecay: RaceModel = {
  id: "velocity-decay",
  name: "Velocity decay",
  source:
    "Log-linear speed–distance decay in the tradition of Léger L & Mercier D, Sports Med 1:270, 1984, fitted to the athlete's own efforts.",
  inputs: "Three or more efforts spanning a range of distances.",
  assumptions: [
    "Sustainable speed falls linearly with the logarithm of distance.",
    "The athlete's recent efforts trace their own decay line.",
  ],
  limitations: [
    "A different functional form from Riegel, but fitted to the same efforts, so it is not an independent opinion.",
    "Extrapolates poorly far outside the fitted distance range.",
  ],
  validKm: [1.5, 60],
  family: "effort-extrapolation",
  predict: (i) => {
    const set = regressionSet(i.efforts);
    if (set.length < 3) return no("Needs at least 3 efforts at different distances.");
    const spread = set[set.length - 1].km / set[0].km;
    if (spread < 1.8) return no("Efforts are too similar in distance to fit a decay line.");
    // speed (m/s) against ln(distance km)
    const fit = ols(set.map((e) => [Math.log(e.km), (e.km * 1000) / e.seconds]));
    if (!fit) return no("Could not fit the decay line.");
    const speed = fit.slope * Math.log(i.targetKm) + fit.intercept;
    if (speed <= 0.5) return no("Fitted decay predicts an implausible speed at this distance.");
    return ok((i.targetKm * 1000) / speed);
  },
};

const tanda: RaceModel = {
  id: "tanda",
  name: "Tanda",
  source:
    "Tanda G, 'Prediction of marathon performance time on the basis of training indices', J Hum Sport Exerc 6(3):511, 2011.",
  inputs: "Mean weekly distance and mean training pace over the 8 weeks before the race.",
  assumptions: [
    "Marathon pace is a function of training volume and habitual training pace alone.",
    "Training in the 8-week window is representative of race preparation.",
  ],
  limitations: [
    "Fitted to 22 runners finishing between 2:47 and 3:16, so it is an extrapolation for athletes far outside that band.",
    "Published for the marathon only. Other distances here are Riegel-scaled from its marathon output, which is our extension and not Tanda's result.",
    "Reported RMSE was about 4 minutes on the marathon even within its own cohort.",
  ],
  validKm: [5, 42.195],
  family: "training-volume",
  predict: (i) => {
    const k = i.weeklyKm;
    const p = i.meanTrainingPaceSecPerKm;
    if (k == null || p == null) return no("Needs 8 weeks of training volume and pace history.");
    if (k < 30 || k > 200) return no(`Weekly volume of ${k.toFixed(0)} km is outside the model's fitted range.`);
    const marathonPace = 17.1 + 140.0 * Math.exp(-0.0053 * k) + 0.55 * p;
    const marathonSecs = marathonPace * 42.195;
    if (i.targetKm === 42.195) return ok(marathonSecs);
    return ok(riegelScale(marathonSecs, 42.195, i.targetKm));
  },
};

const ctlRegression: RaceModel = {
  id: "ctl-regression",
  name: "Chronic load regression",
  source:
    "In-house exponential fit of Banister-model chronic training load to marathon time; the same calibration used by lib/race-predictor.ts.",
  inputs: "Chronic training load (CTL).",
  assumptions: [
    "Accumulated chronic load maps onto race performance along a population-average curve.",
    "Load is comparable between athletes, which TRIMP only roughly achieves.",
  ],
  limitations: [
    "Calibrated on recreational runners against three landmark points, not a published dataset.",
    "Blind to how load was distributed: the same CTL from all easy running and from a polarised block predicts identically.",
  ],
  validKm: [5, 100],
  family: "training-volume",
  predict: (i) => {
    if (i.ctl == null || i.ctl <= 5) return no("No chronic training load available.");
    const marathonSecs = ctlToMarathonSecs(i.ctl);
    return ok(riegelScale(marathonSecs, 42.195, i.targetKm));
  },
};

const volumeHeuristic: RaceModel = {
  id: "volume",
  name: "Volume heuristic",
  source:
    "In-house linear weekly-volume to marathon-time relationship; the same calibration used by lib/race-predictor.ts.",
  inputs: "Mean weekly distance.",
  assumptions: ["Weekly distance alone is a usable first-order proxy for race fitness."],
  limitations: [
    "The crudest model in the bank. It is here as a floor for athletes with almost no other data, and as a check on the effort-based models when they drift.",
    "Knows nothing about intensity, so it cannot distinguish 60 km of jogging from 60 km with two hard sessions.",
  ],
  validKm: [5, 100],
  family: "training-volume",
  predict: (i) => {
    if (i.weeklyKm == null || i.weeklyKm <= 5) return no("No weekly volume history available.");
    const marathonSecs = volumeToMarathonSecs(i.weeklyKm);
    return ok(riegelScale(marathonSecs, 42.195, i.targetKm));
  },
};

/**
 * The bank, in display order: effort extrapolation, then physiological, then
 * training-volume models.
 */
export const RACE_MODELS: RaceModel[] = [
  riegelFixed,
  riegelIndividual,
  cameron,
  velocityDecay,
  danielsVdot,
  acsm,
  criticalSpeed,
  tanda,
  ctlRegression,
  volumeHeuristic,
];

/**
 * Run one model, enforcing its declared distance validity so a model can never
 * silently extrapolate outside the range its source supports.
 */
export function runModel(model: RaceModel, inputs: ModelInputs): ModelResult {
  const [lo, hi] = model.validKm;
  if (inputs.targetKm < lo || inputs.targetKm > hi) {
    return no(`Not valid for ${inputs.targetKm.toFixed(1)} km; this model covers ${lo}–${hi} km.`);
  }
  const result = model.predict(inputs);
  if (result.status === "ok" && (!Number.isFinite(result.seconds) || result.seconds <= 0)) {
    return no("Produced a non-finite result.");
  }
  return result;
}
