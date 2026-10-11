/**
 * Multi-signal race time predictor.
 *
 * METHODOLOGY
 * ───────────
 * Three independent estimation methods are computed and combined:
 *
 *   1. Training-run ensemble (primary)
 *      Riegel formula applied to every recent run ≥ 3 km, corrected for the
 *      gap between training effort and race effort.
 *
 *      When heart-rate data is available the correction is dynamic:
 *        adjusted_pace = observed_pace × (observed_hr_pct / race_hr_pct)
 *      This is the dominant improvement over the previous approach, which
 *      used flat phase-based factors (0.86–0.96) that drastically under-
 *      corrected the easy-run-to-race-pace gap.
 *
 *      When HR is absent the correction uses assumed training HR by phase
 *      and session type, which is still far more accurate than the old
 *      flat corrections.
 *
 *      All runs are included (not just the longest).  Quality/race sessions
 *      receive extra weight; recent runs are weighted over older ones.
 *
 *   2. CTL regression (secondary)
 *      Exponential regression from chronic training load to marathon time,
 *      scaled via Riegel to other distances.  Used as a cross-check.
 *
 *   3. Volume heuristic (fallback)
 *      Empirically calibrated weekly-km → marathon time relationship.
 *
 * CONFIDENCE
 * ──────────
 * Confidence is computed from real factors: HR data coverage, presence of
 * quality/race sessions, agreement between methods, recency and count of
 * informative data, and proximity to race day.
 *
 * NOTE ON avg_hr_pct_max
 * ──────────────────────
 * This field is stored on a 0–100 scale (e.g. 72.4 means 72.4 % of max HR).
 * The race-effort HR targets below use the same scale.
 *
 * NOTE ON workout_type
 * ─────────────────────
 * Stored as string: "race" | "workout" | "long_run" | "easy" | "moderate".
 */

// ── Public types ──────────────────────────────────────────────────────────────

export type ActivityForPrediction = {
  activity_date:          string;
  distance_km:            number | null;
  moving_time_min:        number | null;
  average_pace_sec_per_km: number | null;
  avg_hr_pct_max:         number | null; // 0–100 scale
  workout_type:           string | null; // "race"|"workout"|"long_run"|"easy"|"moderate"
  is_long_run:            boolean | null;
  is_quality_run:         boolean | null;
  is_easy_run:            boolean | null;
};

export type RacePrediction = {
  predictedSeconds:  number;
  rangeLowSeconds:   number;
  rangeHighSeconds:  number;
  confidence:        "high" | "medium" | "low";
  confidenceNote:    string;
  primaryDriver:     string;
  limiter:           string | null;
  methodNote:        string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Distance a goal type implies, in km.
 *
 * `ultra` is the odd one out: it is a category, not a distance, and 80 km is
 * only the middle of it. Use raceKmFor() rather than reading this table
 * directly, so an athlete who named their race distance gets their own number.
 */
export const RACE_KM: Record<string, number> = {
  marathon:        42.195,
  half_marathon:   21.0975,
  "10k":           10,
  "5k":            5,
  ultra:           80,
  improve_fitness: 42.195,
};

/** Goal types whose distance the athlete sets rather than the type implying it. */
const ATHLETE_SET_DISTANCE = new Set(["ultra"]);

/**
 * The race distance to compute against: the athlete's own figure when the goal
 * type does not pin one, the table otherwise. Goals saved before the distance
 * was ever asked for fall back to the table and behave exactly as they did.
 */
export function raceKmFor(goalType: string, eventDistanceKm?: number | null): number | undefined {
  if (
    ATHLETE_SET_DISTANCE.has(goalType) &&
    eventDistanceKm != null && Number.isFinite(eventDistanceKm) && eventDistanceKm > 0
  ) {
    return eventDistanceKm;
  }
  return RACE_KM[goalType];
}

/** Typical race-effort HR as % of max by distance (0–100 scale). */
export const RACE_HR_PCT: Record<string, number> = {
  marathon:      85,
  half_marathon: 88,
  "10k":         92,
  "5k":          95,
  ultra:         78,
};

/**
 * Assumed training HR (% of max) for no-HR fallback, by session type and phase.
 * These represent the typical aerobic training intensity for each combination,
 * used to estimate what the dynamic HR correction would have been.
 */
const ASSUMED_TRAINING_HR: Record<string, Record<string, number>> = {
  quality:   { Base: 83, Build: 84, Peak: 84, Taper: 84, "Race Week": 85, General: 83 },
  long:      { Base: 73, Build: 74, Peak: 76, Taper: 74, "Race Week": 73, General: 73 },
  easy:      { Base: 70, Build: 71, Peak: 73, Taper: 71, "Race Week": 71, General: 71 },
  moderate:  { Base: 76, Build: 77, Peak: 79, Taper: 77, "Race Week": 76, General: 77 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function riegelScale(effortSecs: number, fromKm: number, toKm: number): number {
  return effortSecs * Math.pow(toKm / fromKm, 1.06);
}

/** Slowdown applied to a RUN-derived marathon estimate: Riegel from shorter
 *  efforts over-predicts the marathon (the glycogen wall is unmodelled). ~4%. */
const MARATHON_RUN_FADE = 1.04;

function paceFmt(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

/**
 * Compute the effort-correction factor for a single training run.
 *
 * correction = assumed_training_hr / race_hr_pct
 *
 * If the run was at lower effort (hr < race_hr): correction < 1 → Riegel
 * result will be multiplied down → prediction is faster than raw Riegel.
 * If the run was at higher effort (hr > race_hr): correction > 1 → prediction
 * is slower (conservative — harder efforts are shorter and less efficient for
 * marathon than Riegel alone would suggest).
 */
export function effortCorrection(
  hrPct:         number | null,  // 0–100 scale
  workoutType:   string | null,
  isQuality:     boolean | null,
  isLong:        boolean | null,
  trainingPhase: string,
  raceHrPct:     number,         // 0–100 scale
): number {
  // Strava-tagged race effort → use Riegel as-is
  if (workoutType === "race") return 1.0;

  if (hrPct != null && hrPct > 40) {
    // Dynamic correction using actual HR — most accurate path
    return Math.max(0.68, Math.min(1.08, hrPct / raceHrPct));
  }

  // No HR data — look up assumed training HR
  const sessionKey =
    workoutType === "workout" || isQuality ? "quality"
    : isLong || workoutType === "long_run"  ? "long"
    : workoutType === "easy"               ? "easy"
    :                                        "moderate";

  const phase = trainingPhase in ASSUMED_TRAINING_HR.easy ? trainingPhase : "General";
  const assumedHr = ASSUMED_TRAINING_HR[sessionKey]?.[phase] ?? 74;
  return Math.max(0.68, Math.min(1.08, assumedHr / raceHrPct));
}

// ── Method 2: CTL → marathon time ─────────────────────────────────────────────
// Exponential regression calibrated to Bannister TRIMP for recreational runners.
// Landmark points: CTL 30 → 4:15 (15300s), CTL 50 → 3:30 (12600s), CTL 65 → 3:10 (11400s)
export function ctlToMarathonSecs(ctl: number): number {
  const c = Math.max(10, Math.min(90, ctl));
  // a × exp(-b × c);  a=19311, b=0.00776 (fitted to landmarks above)
  return Math.round(19311 * Math.exp(-0.00776 * c));
}

// ── Method 3: Volume heuristic ────────────────────────────────────────────────
export function volumeToMarathonSecs(weeklyKm: number): number {
  const clamped = Math.max(20, Math.min(120, weeklyKm));
  // 30 km/wk → 4:30, 50 → 4:00, 70 → 3:30, 90 → 3:05, 110 → 2:50
  return Math.round(16200 - (clamped - 30) * 68);
}

// ── Main export ───────────────────────────────────────────────────────────────

export function predictRaceTime(inputs: {
  goalType:        string;
  activities:      ActivityForPrediction[];
  ctl:             number | null;
  acwr:            number | null;
  weeklyAvgKm:     number | null;
  weeksToRace:     number | null;
  trainingPhase:   string;
  goalTimeSeconds: number | null;
  /** The athlete's own race distance, for goal types that do not imply one. */
  eventDistanceKm?: number | null;
  /**
   * "Now" in epoch milliseconds. Explicit so the prediction is reproducible:
   * run recency weights are measured from this instant. (Ported change: the web
   * app read Date.now() here.)
   */
  nowMs: number;
}): RacePrediction | null {
  const {
    goalType, activities, ctl, acwr,
    weeklyAvgKm, weeksToRace, trainingPhase,
  } = inputs;

  if (goalType === "improve_fitness") return null;

  const raceKm    = raceKmFor(goalType, inputs.eventDistanceKm);
  const raceHrPct = RACE_HR_PCT[goalType] ?? 85;
  if (!raceKm) return null;

  const today = inputs.nowMs;

  // ── Method 1: Training-run ensemble ─────────────────────────────────────────
  type RunEstimate = { secs: number; weight: number; label: string };
  const runEstimates: RunEstimate[] = [];

  let hrCoveredCount   = 0;
  let qualityCount     = 0;
  let raceEffortCount  = 0;
  let validRunCount    = 0;

  for (const run of activities) {
    const dist = run.distance_km;
    const tmin = run.moving_time_min;
    if (!dist || dist < 3 || !tmin || tmin < 10) continue;

    // Prefer stored pace; fall back to computing from time+distance
    const pace = run.average_pace_sec_per_km ?? (tmin * 60) / dist;
    if (!pace || pace < 150 || pace > 1200) continue; // sanity: 2:30–20:00/km

    validRunCount++;

    const hr = run.avg_hr_pct_max;
    if (hr != null && hr > 40) hrCoveredCount++;
    if (run.is_quality_run || run.workout_type === "workout") qualityCount++;
    if (run.workout_type === "race") raceEffortCount++;

    // Days since this run
    const daysSince = Math.max(0,
      (today - new Date(run.activity_date).getTime()) / 86400000
    );

    const correction = effortCorrection(
      hr, run.workout_type, run.is_quality_run, run.is_long_run,
      trainingPhase, raceHrPct,
    );

    // Adjusted pace at estimated race effort, then Riegel to target distance
    const adjustedPace   = pace * correction;
    const adjustedEffort = adjustedPace * dist;
    const rawRiegelSecs  = riegelScale(adjustedEffort, dist, raceKm);

    // Taper adjustment: in taper, recent volume is intentionally low;
    // don't let that signal degrade the prediction — apply mild boost.
    const taperBoost = (trainingPhase === "Taper" || trainingPhase === "Race Week")
      ? 0.97 : 1.0;
    const predictedSecs = Math.round(rawRiegelSecs * taperBoost);

    // Weight components
    const recencyW   = Math.exp(-daysSince / 28);      // exponential decay (28-day half-life)
    const distanceW  = Math.min(1.0, dist / 20);       // full weight at 20 km+
    const hrQualW    = hr != null && hr > 40 ? 1.5 : 1.0; // HR data improves reliability
    const sessionW   = run.workout_type === "race" ? 2.5
                     : run.is_quality_run || run.workout_type === "workout" ? 1.8
                     : run.is_long_run    || run.workout_type === "long_run" ? 1.2
                     : 1.0;

    const weight = recencyW * distanceW * hrQualW * sessionW;

    const sessionDesc = run.workout_type === "race" ? "race effort"
      : run.is_quality_run ? "quality session"
      : run.is_long_run    ? "long run"
      : run.is_easy_run    ? "easy run"
      : "run";

    runEstimates.push({
      secs: predictedSecs,
      weight,
      label: `${dist.toFixed(1)} km ${sessionDesc} at ${paceFmt(pace)}${hr != null ? ` (HR ${hr.toFixed(0)}%)` : ""}`,
    });
  }

  // Sort by weight; take top 6 for averaging
  runEstimates.sort((a, b) => b.weight - a.weight);
  const topRuns = runEstimates.slice(0, 6);

  let ensembleRunSecs: number | null = null;
  let bestLabel = "";
  if (topRuns.length > 0) {
    const totalW = topRuns.reduce((s, e) => s + e.weight, 0);
    ensembleRunSecs = Math.round(
      topRuns.reduce((s, e) => s + e.secs * e.weight, 0) / totalW,
    );
    bestLabel = topRuns[0].label;
    // Riegel (exp 1.06) extrapolated from shorter efforts over-predicts the
    // marathon because it does not model the glycogen wall. Fade the run-based
    // marathon estimate so the prediction does not flatter the runner where
    // realism matters most. CTL/volume models below are already marathon-
    // calibrated, so they are left untouched.
    if (goalType === "marathon") ensembleRunSecs = Math.round(ensembleRunSecs * MARATHON_RUN_FADE);
  }

  // ── Method 2: CTL-based estimate ────────────────────────────────────────────
  let ctlSecs: number | null = null;
  if (ctl != null && ctl > 5) {
    const marathonSecs = ctlToMarathonSecs(ctl);
    ctlSecs = Math.round(riegelScale(marathonSecs, 42.195, raceKm));
  }

  // ── Method 3: Volume heuristic ───────────────────────────────────────────────
  let volSecs: number | null = null;
  if (weeklyAvgKm != null && weeklyAvgKm > 5) {
    const marathonSecs = volumeToMarathonSecs(weeklyAvgKm);
    volSecs = Math.round(riegelScale(marathonSecs, 42.195, raceKm));
  }

  // ── Ensemble ─────────────────────────────────────────────────────────────────
  let predictedSecs: number;
  let method: string;
  let driver: string;

  const hasRuns = ensembleRunSecs != null;
  const hasCtl  = ctlSecs != null;
  const hasVol  = volSecs != null;

  if (!hasRuns && !hasCtl && !hasVol) return null;

  // Weights: runs are primary; CTL and volume cross-checks. A recent actual race
  // (race-type effort in the window) is the single most reliable data point, so
  // it should DOMINATE rather than be diluted by the weaker CTL/volume priors
  // (which otherwise dragged a just-run 40:00 10k toward a 46:00 prediction).
  const hasRecentRace = raceEffortCount > 0;
  const hrCoverage = validRunCount > 0 ? hrCoveredCount / validRunCount : 0;
  const runsW  = hasRuns ? (0.50 + hrCoverage * 0.20 + (qualityCount > 0 ? 0.10 : 0) + (hasRecentRace ? 0.70 : 0)) : 0;
  const ctlW   = hasCtl  ? (hasRecentRace ? 0.05 : 0.20) : 0;
  const volW   = hasVol  ? (hasRecentRace ? 0.03 : hasRuns ? 0.10 : 0.40) : 0;
  const totalW = runsW + ctlW + volW || 1;

  predictedSecs = Math.round(
    ((ensembleRunSecs ?? 0) * runsW + (ctlSecs ?? 0) * ctlW + (volSecs ?? 0) * volW) / totalW,
  );

  // If only CTL or volume available (no run data):
  if (!hasRuns) {
    if (hasCtl && hasVol) {
      predictedSecs = Math.round((ctlSecs! + volSecs!) / 2);
      method = `Volume (${weeklyAvgKm!.toFixed(0)} km/week) and CTL (${ctl!.toFixed(1)}) combined estimate`;
      driver = `Weekly training volume and chronic load`;
    } else if (hasCtl) {
      predictedSecs = ctlSecs!;
      method = `CTL-based estimate (CTL = ${ctl!.toFixed(1)})`;
      driver = `Chronic training load`;
    } else {
      predictedSecs = volSecs!;
      method = `Volume-based estimate (${weeklyAvgKm!.toFixed(0)} km/week)`;
      driver = `Weekly training volume`;
    }
  } else {
    const parts: string[] = [];
    parts.push(`training-run ensemble (${topRuns.length} effort${topRuns.length !== 1 ? "s" : ""})`);
    if (hasCtl) parts.push(`CTL (${ctl!.toFixed(1)})`);
    if (hasVol) parts.push(`volume (${weeklyAvgKm!.toFixed(0)} km/week)`);
    method = `Multi-signal: ${parts.join(" + ")}`;
    driver = bestLabel;
  }

  // ── Method agreement check ────────────────────────────────────────────────────
  const availableMethods = [ensembleRunSecs, ctlSecs, volSecs].filter(Boolean) as number[];
  const methodSpreadPct = availableMethods.length > 1
    ? (Math.max(...availableMethods) - Math.min(...availableMethods)) / predictedSecs
    : 0;

  // ── Confidence ───────────────────────────────────────────────────────────────
  let confidence: "high" | "medium" | "low";
  let confidenceNote: string;

  const farFromRace   = (weeksToRace ?? 99) > 16;
  const earlyPhase    = trainingPhase === "Base" || trainingPhase === "General";
  const goodHrCover   = hrCoverage >= 0.5;
  const hasQualityRun = qualityCount > 0 || raceEffortCount > 0;
  const goodDataCount = validRunCount >= 8;
  const methodsAgree  = methodSpreadPct < 0.12;

  const confidenceScore =
    (goodHrCover   ? 2 : 0) +
    (hasQualityRun ? 2 : 0) +
    (goodDataCount ? 1 : 0) +
    (methodsAgree  ? 1 : 0) +
    (!farFromRace  ? 1 : 0) +
    (!earlyPhase   ? 1 : 0);

  if (confidenceScore >= 6) {
    confidence = "high";
    confidenceNote = "Strong confidence: HR-covered training data, quality sessions present, multiple methods in close agreement, and race within 16 weeks.";
  } else if (confidenceScore >= 3) {
    confidence = "medium";
    confidenceNote = [
      "Medium confidence.",
      !goodHrCover   && "Limited HR coverage reduces physiological precision.",
      !hasQualityRun && "No quality sessions detected — estimate relies on easy-run data with effort correction applied.",
      farFromRace    && "Race is still far away — prediction will sharpen as the plan progresses.",
      !methodsAgree  && `Training-run and load/volume methods diverge by ${(methodSpreadPct * 100).toFixed(0)} % — interpret range broadly.`,
    ].filter(Boolean).join(" ");
  } else {
    confidence = "low";
    confidenceNote = [
      "Low confidence.",
      !goodHrCover   && "Most activities lack heart-rate data, preventing effort-based calibration.",
      !hasQualityRun && "No quality or race-effort sessions found — all estimates are extrapolated from easy training pace.",
      !goodDataCount && "Fewer than 8 analysed runs in the window.",
      earlyPhase     && "Still in an early training phase — this is a directional estimate only.",
    ].filter(Boolean).join(" ");
  }

  // ── Uncertainty range ─────────────────────────────────────────────────────────
  // Wider when method agreement is poor or confidence is low
  const baseRange = confidence === "high" ? 0.05 : confidence === "medium" ? 0.09 : 0.14;
  const spreadBonus = Math.min(0.05, methodSpreadPct / 2);
  const rangePct = baseRange + spreadBonus;

  const rangeLow  = Math.round(predictedSecs * (1 - rangePct));
  const rangeHigh = Math.round(predictedSecs * (1 + rangePct));

  // ── Limiter ───────────────────────────────────────────────────────────────────
  let limiter: string | null = null;
  if (!goodHrCover) {
    limiter = "Limited heart-rate data — effort correction uses assumed training intensity rather than measured physiology";
  } else if (!hasQualityRun && !earlyPhase) {
    limiter = "No tempo or interval sessions detected in the last 8 weeks — race-specific conditioning may be under-represented";
  } else if (acwr != null && acwr < 0.8) {
    limiter = "Training load is below the optimal range (ACWR < 0.8) — possible under-preparation";
  }

  // ── Sanity check ─────────────────────────────────────────────────────────────
  // Clamp to plausible range for the distance
  const minPlausible: Record<string, number> = {
    marathon: 7200, half_marathon: 3600, "10k": 1500, "5k": 720, ultra: 14400,
  };
  const maxPlausible: Record<string, number> = {
    marathon: 28800, half_marathon: 14400, "10k": 5400, "5k": 2700, ultra: 72000,
  };
  const clamped = Math.max(
    minPlausible[goalType] ?? 720,
    Math.min(maxPlausible[goalType] ?? 72000, predictedSecs),
  );
  const hitWall = clamped !== predictedSecs;
  // Hitting the plausibility wall used to `return null`, which silently dropped
  // not just the prediction but the athlete's current-fitness paces and the
  // goal-realism note (both derive from it). Instead return the clamped boundary
  // at low confidence so those still render, just flagged as rough.
  const finalSecs = clamped;

  return {
    predictedSeconds: finalSecs,
    rangeLowSeconds:  Math.min(rangeLow, finalSecs),
    rangeHighSeconds: Math.max(rangeHigh, finalSecs),
    confidence:       hitWall ? "low" : confidence,
    confidenceNote:   hitWall ? "Projection landed outside the plausible range for this distance and was clamped to the boundary; treat it as a rough estimate." : confidenceNote,
    primaryDriver: driver,
    limiter:       hitWall ? (limiter ?? "projection outside the plausible range for this distance") : limiter,
    methodNote:    method,
  };
}

// ── Format helpers ────────────────────────────────────────────────────────────

export function fmtPredictedTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
