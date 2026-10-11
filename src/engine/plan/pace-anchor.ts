/**
 * Where an athlete's run paces come from (#121, PACE_ANCHORS).
 *
 * Threshold and interval paces used to be fixed ratios of the athlete's easy
 * pace (0.90 and 0.85). A real coach anchors on the best evidence of what the
 * athlete can actually run, so this takes the first of, in order:
 *
 *   1. a race result from the last 6 months (race_results, a run, not a DNF);
 *   1b. a completed assessment-week time trial (#121, C5), timed from the
 *      fastest consecutive splits of the run it was recorded in;
 *   2. a race-tagged run from the last 6 months (Strava's race flag, or a run
 *      named as a race), 3 km or longer;
 *   3. the race predictor for the goal distance, at medium or high confidence;
 *   4. the easy-pace ratios, the last resort, flagged so the plan notes say the
 *      paces are an estimate.
 *
 * Paces from 1-3 use pacesFromRaceTime, the same Riegel arithmetic goal paces
 * use. Easy pace stays the athlete's measured easy pace whenever they have one:
 * it is what they actually run, and a race says little about it.
 *
 * Older than 6 months is ignored, not discounted. A candidate whose implied
 * threshold is no faster than the athlete's own easy pace was not a race effort
 * (a jogged parkrun, a marathon walked in) and is skipped.
 */

import { pacesFromEasyPace, pacesFromRaceTime, fmtPace } from "../zones/goal-paces";
import { RACE_KM, raceKmFor } from "../predict/race-predictor";

export const ANCHOR_WINDOW_DAYS = 183;
const MIN_ANCHOR_KM = 3;
/** Faster than this threshold pace (sec/km) is a data error, not an athlete. */
const FASTEST_PLAUSIBLE_THRESHOLD = 150;

export type PaceAnchorSource = "race_result" | "benchmark" | "race_activity" | "predictor" | "easy_ratio";

export type PaceAnchor = {
  source: PaceAnchorSource;
  /** One line for the coach's context: what the paces stand on. */
  basis: string;
  date: string | null;
  easyPaceSecPerKm: number;
  thresholdPaceSecPerKm: number;
  intervalPaceSecPerKm: number;
};

export type AnchorRaceRow = {
  race_date: string;
  event_name?: string | null;
  distance_type: string | null;
  distance_km: number | null;
  finish_time_seconds: number | null;
  dnf: boolean | null;
  sport: string | null;
};

export type AnchorBenchmark = { date: string; km: number; seconds: number };

export type AnchorRaceActivity = { activity_date: string; distance_km: number | null; moving_time_min: number | null };

export type AnchorPrediction = { predictedSeconds: number; confidence: "high" | "medium" | "low"; goalType: string; eventDistanceKm: number | null };

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function choosePaceAnchor(input: {
  today: string;
  races: AnchorRaceRow[];
  raceActivities: AnchorRaceActivity[];
  prediction: AnchorPrediction | null;
  measuredEasyPace: number | null;
  benchmarks?: AnchorBenchmark[];
}): PaceAnchor | null {
  const { today, measuredEasyPace } = input;
  const recent = (d: string) => { const n = daysBetween(d, today); return n >= 0 && n <= ANCHOR_WINDOW_DAYS; };

  const fromTime = (seconds: number, km: number, source: PaceAnchorSource, basis: string, date: string | null): PaceAnchor | null => {
    const p = pacesFromRaceTime(seconds, km);
    if (!p || p.thresholdPaceSecPerKm < FASTEST_PLAUSIBLE_THRESHOLD) return null;
    if (measuredEasyPace != null && p.thresholdPaceSecPerKm >= measuredEasyPace) return null; // not a race effort
    return {
      source, basis, date,
      easyPaceSecPerKm: measuredEasyPace ?? p.easyPaceSecPerKm,
      thresholdPaceSecPerKm: p.thresholdPaceSecPerKm,
      intervalPaceSecPerKm: p.intervalPaceSecPerKm,
    };
  };

  // 1. Race results, newest first.
  const races = input.races
    .filter((r) => (r.sport ?? "run") === "run" && !r.dnf && (r.finish_time_seconds ?? 0) > 0 && recent(r.race_date))
    .map((r) => ({ r, km: r.distance_km ?? (r.distance_type ? RACE_KM[r.distance_type] ?? null : null) }))
    .filter((x): x is { r: AnchorRaceRow; km: number } => x.km != null && x.km >= MIN_ANCHOR_KM)
    .sort((a, b) => b.r.race_date.localeCompare(a.r.race_date));
  for (const { r, km } of races) {
    const label = r.event_name?.trim() || r.distance_type || `${km} km race`;
    const a = fromTime(r.finish_time_seconds as number, km, "race_result",
      `${label} on ${r.race_date} in ${fmtDuration(r.finish_time_seconds as number)}`, r.race_date);
    if (a) return a;
  }

  // 1b. Assessment-week time trials, newest first.
  const trials = (input.benchmarks ?? [])
    .filter((b) => b.km >= MIN_ANCHOR_KM && b.seconds > 0 && recent(b.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const b of trials) {
    const a = fromTime(b.seconds, b.km, "benchmark", `${b.km} km time trial on ${b.date} in ${fmtDuration(b.seconds)}`, b.date);
    if (a) return a;
  }

  // 2. Race-tagged runs, newest first.
  const acts = input.raceActivities
    .filter((x) => (x.distance_km ?? 0) >= MIN_ANCHOR_KM && (x.moving_time_min ?? 0) > 0 && recent(x.activity_date))
    .sort((a, b) => b.activity_date.localeCompare(a.activity_date));
  for (const x of acts) {
    const secs = (x.moving_time_min as number) * 60;
    const a = fromTime(secs, x.distance_km as number, "race_activity",
      `race-tagged ${Math.round((x.distance_km as number) * 10) / 10} km run on ${x.activity_date} in ${fmtDuration(secs)}`, x.activity_date);
    if (a) return a;
  }

  // 3. The predictor, when it is confident enough to stand on.
  const pr = input.prediction;
  if (pr && (pr.confidence === "high" || pr.confidence === "medium")) {
    const km = raceKmFor(pr.goalType, pr.eventDistanceKm);
    if (km) {
      const a = fromTime(pr.predictedSeconds, km, "predictor",
        `race predictor (${pr.confidence} confidence): ${pr.goalType.replace(/_/g, " ")} in ${fmtDuration(pr.predictedSeconds)}`, null);
      if (a) return a;
    }
  }

  // 4. Easy-pace ratios.
  if (measuredEasyPace != null) {
    const p = pacesFromEasyPace(measuredEasyPace);
    return {
      source: "easy_ratio",
      basis: `estimated from recent easy runs at ${fmtPace(measuredEasyPace)}/km (no race in the last 6 months)`,
      date: null,
      easyPaceSecPerKm: p.easyPaceSecPerKm,
      thresholdPaceSecPerKm: p.thresholdPaceSecPerKm,
      intervalPaceSecPerKm: p.intervalPaceSecPerKm,
    };
  }
  return null;
}
