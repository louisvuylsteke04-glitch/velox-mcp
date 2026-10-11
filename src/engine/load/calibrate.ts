/**
 * Load calibration for runs without heart rate. NEW in velox-mcp, not in the
 * web app. See docs/LOAD_CALIBRATION.md.
 *
 * Why: the web app ingested average HR for every run, so every run's load was
 * Banister TRIMP. Through Claude's Strava connector HR costs one call per run,
 * so typically only the last few runs carry it. Scoring the rest with the raw
 * pace proxy (a scale roughly 3-4x lower) makes recent weeks look like a spike
 * and raises false injury-risk alarms.
 *
 * What: the athlete's own HR runs calibrate the other runs onto the TRIMP scale.
 *   1. Strava relative_effort (HR-based, returned for nearly every run) × k_re,
 *      where k_re is the median TRIMP / relative_effort over HR runs.
 *   2. Otherwise the pace proxy × k_pace, the median TRIMP / pace-proxy ratio.
 *   3. Otherwise (fewer than MIN_CALIBRATION_RUNS HR runs) the raw pace proxy,
 *      exactly as the web app scored it.
 * Runs that have HR are never touched, so with full HR coverage the result is
 * identical to the web app.
 */
import type { RunFeatures } from "./run-features";

export const MIN_CALIBRATION_RUNS = 3;

export type LoadMethod = "heart_rate" | "relative_effort" | "pace_calibrated" | "pace";

export type Calibration = {
  kRelativeEffort: number | null;
  kPace: number | null;
  calibrationRuns: number;
  methods: LoadMethod[];
  counts: Record<LoadMethod, number>;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The web app's no-HR pace proxy (see run-features.ts). */
export function paceProxyTrimp(f: Pick<RunFeatures, "moving_time_min" | "average_pace_sec_per_km">): number {
  const pace = f.average_pace_sec_per_km ?? 360;
  const effortFactor = Math.min(1.2, Math.max(0.25, 300 / pace));
  return f.moving_time_min * effortFactor * 0.55;
}

/**
 * Returns new feature rows with calibrated `trimp` for runs that lack HR.
 * `relativeEffort[i]` is Strava's relative_effort for features[i], or null.
 */
export function calibrateLoad(
  features: RunFeatures[],
  relativeEffort: (number | null)[],
): { features: RunFeatures[]; calibration: Calibration } {
  const hasHr = (f: RunFeatures) => f.data_quality_score >= 0.9 && f.trimp != null && f.trimp > 0;

  const reRatios: number[] = [];
  const paceRatios: number[] = [];
  features.forEach((f, i) => {
    if (!hasHr(f)) return;
    const re = relativeEffort[i];
    if (re != null && re > 0) reRatios.push(f.trimp! / re);
    const proxy = paceProxyTrimp(f);
    if (proxy > 0) paceRatios.push(f.trimp! / proxy);
  });
  const kRelativeEffort = reRatios.length >= MIN_CALIBRATION_RUNS ? median(reRatios) : null;
  const kPace = paceRatios.length >= MIN_CALIBRATION_RUNS ? median(paceRatios) : null;

  const counts: Record<LoadMethod, number> = { heart_rate: 0, relative_effort: 0, pace_calibrated: 0, pace: 0 };
  const methods: LoadMethod[] = [];
  const out = features.map((f, i) => {
    let method: LoadMethod;
    let trimp = f.trimp;
    if (hasHr(f)) {
      method = "heart_rate";
    } else if (kRelativeEffort != null && relativeEffort[i] != null && relativeEffort[i]! > 0) {
      method = "relative_effort";
      trimp = relativeEffort[i]! * kRelativeEffort;
    } else if (kPace != null && f.distance_km > 0) {
      method = "pace_calibrated";
      trimp = paceProxyTrimp(f) * kPace;
    } else {
      method = "pace";
    }
    counts[method]++;
    methods.push(method);
    return trimp === f.trimp ? f : { ...f, trimp, session_load_basic: trimp ?? f.session_load_basic };
  });

  return {
    features: out,
    calibration: { kRelativeEffort, kPace, calibrationRuns: paceRatios.length, methods, counts },
  };
}
