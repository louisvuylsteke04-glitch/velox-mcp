/**
 * The athlete profile: one picture of where this athlete actually is, read by
 * everything downstream (the envelopes, the blueprint brief, the invariants).
 *
 * Ported from the Vēlox web app's lib/plan/profile.ts. The types are unchanged.
 * The builder is the same arithmetic with the database reads replaced by
 * arguments and "now" passed in. velox-mcp is running-only: bike and swim are
 * always empty, and the combined load model is the run model (identical to the
 * web app's when there is no cross-training).
 */
import { normaliseSex } from "../load/training-load";
import { buildRunLoadModel, type RunDay } from "../load/load-model";
import { estimateFtpFromRides, estimateCss, type ThresholdEstimate } from "./thresholds";
import { pacesFromEasyPace } from "../zones/goal-paces";
import { predictRaceTime, type ActivityForPrediction } from "../predict/race-predictor";
import { choosePaceAnchor, type AnchorRaceRow, type AnchorRaceActivity, type AnchorBenchmark, type PaceAnchorSource } from "./pace-anchor";
import {
  classifyInjury, detectMedicalEscalation, missedTrainingAdjustment, computeAgeYears,
  type InjuryContext, type MedicalEscalation, type MissedTrainingAction,
  type ConcernRow, type PainLogRow,
} from "../injury-model";
import { readTrainingPreferences, type TrainingPreferences } from "../training-preferences";

/** The web app's combined-sport summary shape (lib/multisport-load.ts). */
export type MultisportSummary = {
  ctl: number;
  atl: number;
  tsb: number;
  formLabel: string;
  formColor: string;
  rampPct: number | null;
  monotony: number | null;
  strain: number | null;
  runSharePct: number | null;
  runShare7Pct: number | null;
  weekLoad7: { run: number; bike: number; swim: number; total: number };
  hasData: boolean;
};

const FORM_COLOR: Record<string, string> = { Fresh: "#4A8771", Neutral: "#A07A2E", Fatigued: "#B85C45" };

const DAY_MS = 86_400_000;
const ymd = (d: number) => new Date(d).toISOString().slice(0, 10);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Window for "where they are now". Four complete weeks is long enough to smooth a
 *  single odd week and short enough to track a real change in training. */
const RECENT_DAYS = 28;
/** Window for "what they have demonstrated": a big long ride six weeks ago is still
 *  evidence of capability, even if last week was quiet. */
const CAPABILITY_DAYS = 42;
/** History depth for the load model and volume trend. */
const HISTORY_DAYS = 120;

export type RunFitness = {
  hasData: boolean;
  sessions4w: number;
  /** Mean weekly km over the last 4 complete weeks. */
  weeklyKm: number;
  /** Last 8 complete weeks, oldest first (the trend the ramp is judged against). */
  weeklyKmHistory: number[];
  /** Longest single run in the capability window. */
  longestKm: number;
  daysSinceLast: number | null;
  /** Mean pace of recent easy runs (sec/km), the anchor for derived run paces. */
  easyPaceSecPerKm: number | null;
  thresholdPaceSecPerKm: number | null;
  intervalPaceSecPerKm: number | null;
  /** What the paces stand on, under PACE_ANCHORS (#121, C2). Absent without it. */
  paceAnchor?: { source: PaceAnchorSource; basis: string } | null;
};

export type BikeFitness = {
  hasData: boolean;
  hasPower: boolean;
  sessions4w: number;
  /** Mean weekly riding hours over the last 4 complete weeks. */
  weeklyHours: number;
  /** Longest single ride (hours) in the capability window. */
  longestRideHours: number;
  /** Mean moving speed of outdoor rides (km/h), used to turn event distance into time. */
  avgSpeedKmh: number | null;
  daysSinceLast: number | null;
  ftp: ThresholdEstimate<number>;
};

export type SwimFitness = {
  hasData: boolean;
  /** False when the athlete's swims record time but no distance (common for open
   *  water and for pools without a distance sensor). Metre targets are meaningless
   *  for these athletes, so the plan must prescribe swims by time instead. */
  distanceRecorded: boolean;
  sessions4w: number;
  /** Mean weekly metres over the last 4 complete weeks (0 when distance is absent). */
  weeklyMetres: number;
  weeklyHours: number;
  longestSwimM: number;
  daysSinceLast: number | null;
  css: ThresholdEstimate<number>;
};

/**
 * One week of training across every sport, in each sport's own units plus the
 * shared TSS currency. This is the table a coach reads to see periodisation: what
 * the athlete has actually been doing, week by week, in all three disciplines.
 */
export type ProfileWeek = {
  week_start: string;
  runKm: number;
  bikeHours: number;
  swimMetres: number;
  tss: { run: number; bike: number; swim: number; total: number };
};

export type AthleteProfile = {
  athleteId: number;
  name: string;
  firstName: string;
  ageYears: number | null;
  sex: "male" | "female" | null;
  weightKg: number | null;
  experienceLevel: string | null;
  maxHr: number | null;
  restHr: number | null;
  hrZoneMaxPcts: number[] | null;
  run: RunFitness;
  bike: BikeFitness;
  swim: SwimFitness;
  /** The last 12 complete weeks across all sports, oldest first. */
  weekly: ProfileWeek[];
  /** Combined-sport load picture (TSS): fitness, fatigue, form, ramp, monotony. */
  load: MultisportSummary;
  /** Week-over-week change in impact-weighted load, the injury-risk view of a ramp. */
  mechanicalRampPct: number | null;
  injury: InjuryContext;
  medical: MedicalEscalation;
  missedTraining: { action: MissedTrainingAction; volumeFactor: number; note: string };
  recentHighFatigue: boolean;
  prefs: TrainingPreferences;
};

/** Monday of the ISO week containing a date, in UTC. */
function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * The Mondays of the last `weeks` COMPLETE ISO weeks, oldest first.
 *
 * Anchoring on the calendar rather than on "weeks that happen to contain data" is
 * the whole point: an athlete whose last run was six weeks ago has been running
 * zero km per week since, not the average of whatever their last four active weeks
 * held. The current partial week is excluded so a Tuesday regeneration does not
 * read two logged days as a whole week.
 */
function completeWeekStarts(weeks: number, nowMs: number): string[] {
  const thisMonday = new Date(mondayOf(ymd(nowMs)) + "T00:00:00Z");
  const out: string[] = [];
  for (let i = weeks; i >= 1; i--) {
    const d = new Date(thisMonday.getTime() - i * 7 * DAY_MS);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Bucket rows into per-calendar-week totals, zeros included. */
function weeklyBuckets<T extends { activity_date: string }>(rows: T[], value: (r: T) => number, weeks: number, nowMs: number): number[] {
  const starts = completeWeekStarts(weeks, nowMs);
  const totals = new Map(starts.map((s) => [s, 0]));
  for (const r of rows) {
    const wk = mondayOf(r.activity_date);
    if (!totals.has(wk)) continue; // outside the window, or the partial current week
    totals.set(wk, (totals.get(wk) ?? 0) + value(r));
  }
  return starts.map((s) => totals.get(s) ?? 0);
}

/** Mean weekly total over the last `weeks` complete calendar weeks. */
function weeklyMean<T extends { activity_date: string }>(rows: T[], value: (r: T) => number, weeks: number, nowMs: number): number {
  const b = weeklyBuckets(rows, value, weeks, nowMs);
  return b.reduce((a, x) => a + x, 0) / weeks;
}

/** Per-week totals, oldest first, for the last `weeks` complete calendar weeks. */
function weeklySeries<T extends { activity_date: string }>(rows: T[], value: (r: T) => number, weeks: number, nowMs: number): number[] {
  return weeklyBuckets(rows, value, weeks, nowMs).map((x) => Math.round(x));
}

function daysSince(dates: string[], nowMs: number): number | null {
  if (!dates.length) return null;
  const latest = dates.reduce((a, b) => (a > b ? a : b));
  return Math.floor((nowMs - new Date(latest + "T00:00:00Z").getTime()) / DAY_MS);
}


/** One run as the profile reads it (a subset of RunFeatures, plus session RPE). */
export type ProfileRun = {
  activity_date: string;
  distance_km: number | null;
  moving_time_min: number | null;
  average_pace_sec_per_km: number | null;
  trimp: number | null;
  is_easy_run: boolean | null;
  data_quality_score: number | null;
  rpe?: number | null;
};

/** What the web app read for pace anchors (PACE_ANCHORS), passed in. */
export type AnchorData = {
  races: AnchorRaceRow[];
  raceActivities: AnchorRaceActivity[];
  goal: { goal_type: string; race_date: string | null; goal_time_seconds: number | null; goal_distance_m: number | null } | null;
  predictionRuns: ActivityForPrediction[];
  benchmarks: AnchorBenchmark[];
};

export type ProfileInput = {
  /** Today, YYYY-MM-DD. */
  today: string;
  /** "Now" in epoch ms; defaults to midday UTC on `today`. */
  nowMs?: number;
  /** Runs from the last 120 days, any order. */
  runs: ProfileRun[];
  name?: string | null;
  birthDate?: string | null;
  sex?: string | null;
  weightKg?: number | null;
  experienceLevel?: string | null;
  maxHr?: number | null;
  restHr?: number | null;
  hrZoneMaxPcts?: number[] | null;
  injuryHistory?: string[] | null;
  /** Active or monitoring concerns mentioned in the last 14 days. */
  concerns?: ConcernRow[] | null;
  /** Pain areas logged on runs in the last 10 days. */
  painLogs?: PainLogRow[] | null;
  /** RPE / fatigue logged on planned sessions in the last 28 days. */
  feedback?: { rpe: number | null; fatigue_rating: number | null }[] | null;
  /** Raw training preferences; normalised like the web app's stored value. */
  preferences?: unknown;
  /** Pace-anchor evidence. Null keeps paces on easy-pace ratios. */
  anchor?: AnchorData | null;
};

export function buildAthleteProfile(input: ProfileInput): AthleteProfile {
  const nowMs = input.nowMs ?? Date.parse(`${input.today}T12:00:00Z`);
  const sinceHistory = ymd(nowMs - HISTORY_DAYS * DAY_MS);
  const sinceCapability = ymd(nowMs - CAPABILITY_DAYS * DAY_MS);
  const since28d = ymd(nowMs - RECENT_DAYS * DAY_MS);

  // The web app read the last 120 days, newest first, at most 400 runs.
  const runs = input.runs
    .filter((r) => r.activity_date >= sinceHistory && r.activity_date <= input.today)
    .sort((a, b) => b.activity_date.localeCompare(a.activity_date))
    .slice(0, 400);

  const inWindow = <T extends { activity_date: string }>(rows: T[], since: string): T[] =>
    rows.filter((r) => r.activity_date >= since);
  const runs4w = inWindow(runs, since28d);
  const runsCap = inWindow(runs, sinceCapability);

  // ── Run ─────────────────────────────────────────────────────────────────────
  const easyPaces = runs
    .filter((r) => r.is_easy_run === true && r.average_pace_sec_per_km != null && r.average_pace_sec_per_km > 0)
    .slice(0, 8)
    .map((r) => r.average_pace_sec_per_km as number);
  const easyPace = easyPaces.length ? Math.round(easyPaces.reduce((x, y) => x + y, 0) / easyPaces.length) : null;
  const derived = easyPace != null ? pacesFromEasyPace(easyPace) : null;

  const run: RunFitness = {
    hasData: runs.length > 0,
    sessions4w: runs4w.length,
    weeklyKm: Math.round(weeklyMean(runs, (r: ProfileRun) => r.distance_km ?? 0, 4, nowMs)),
    weeklyKmHistory: weeklySeries(runs, (r: ProfileRun) => r.distance_km ?? 0, 8, nowMs),
    longestKm: runsCap.length ? r1(Math.max(...runsCap.map((r) => r.distance_km ?? 0))) : 0,
    daysSinceLast: daysSince(runs.map((r) => r.activity_date), nowMs),
    easyPaceSecPerKm: easyPace,
    thresholdPaceSecPerKm: derived?.thresholdPaceSecPerKm ?? null,
    intervalPaceSecPerKm: derived?.intervalPaceSecPerKm ?? null,
  };

  // ── Bike and swim: not tracked in velox-mcp (running only) ─────────────────
  const bike: BikeFitness = {
    hasData: false, hasPower: false, sessions4w: 0, weeklyHours: 0, longestRideHours: 0,
    avgSpeedKmh: null, daysSinceLast: null, ftp: estimateFtpFromRides([], null),
  };
  const swim: SwimFitness = {
    hasData: false, distanceRecorded: false, sessions4w: 0, weeklyMetres: 0, weeklyHours: 0,
    longestSwimM: 0, daysSinceLast: null, css: estimateCss([], null),
  };

  // ── Load ────────────────────────────────────────────────────────────────────
  const model = buildRunLoadModel({
    runs: runs.map((r): RunDay => ({
      activity_date: r.activity_date, trimp: r.trimp, moving_time_min: r.moving_time_min,
      distance_km: r.distance_km, data_quality_score: r.data_quality_score, rpe: r.rpe ?? null,
    })),
    startDate: sinceHistory,
    endDate: ymd(nowMs),
  });
  const last28 = model.daily.slice(Math.max(0, model.daily.length - 28));
  const run28 = last28.reduce((a, p) => a + p.run, 0);
  const s = model.summary;
  const load: MultisportSummary = {
    ctl: s.ctl, atl: s.atl, tsb: s.tsb, formLabel: s.formLabel, formColor: FORM_COLOR[s.formLabel],
    rampPct: s.rampPct, monotony: s.monotony, strain: s.strain,
    runSharePct: run28 > 0 ? 100 : null,
    runShare7Pct: s.weekLoad7 > 0 ? 100 : null,
    weekLoad7: { run: s.weekLoad7, bike: 0, swim: 0, total: s.weekLoad7 },
    hasData: s.hasData,
  };

  // Impact-weighted ramp on the last COMPLETE week vs the four before it. With
  // running only, the mechanical load is the run load.
  const thisMonday = mondayOf(ymd(nowMs));
  const completeWeeks = model.weekly.filter((w) => w.week_start < thisMonday);
  const mechLast = completeWeeks.length ? Math.round(completeWeeks[completeWeeks.length - 1].run) : 0;
  const mechPrev = completeWeeks.length >= 5
    ? completeWeeks.slice(-5, -1).reduce((acc, w) => acc + Math.round(w.run), 0) / 4
    : 0;
  const mechanicalRampPct = mechPrev > 0 ? Math.round(((mechLast - mechPrev) / mechPrev) * 100) : null;

  const WEEKS_SHOWN = 12;
  const weekStarts = completeWeekStarts(WEEKS_SHOWN, nowMs);
  const runKmByWeek = weeklyBuckets(runs, (r) => r.distance_km ?? 0, WEEKS_SHOWN, nowMs);
  const tssByWeek = new Map(model.weekly.map((w) => [w.week_start, w]));
  const weekly: ProfileWeek[] = weekStarts.map((week_start, i) => {
    const t = tssByWeek.get(week_start);
    return {
      week_start,
      runKm: Math.round(runKmByWeek[i]),
      bikeHours: 0,
      swimMetres: 0,
      tss: { run: Math.round(t?.run ?? 0), bike: 0, swim: 0, total: Math.round(t?.total ?? 0) },
    };
  });

  // ── Readiness signals ───────────────────────────────────────────────────────
  const feedback = input.feedback ?? [];
  const recentHighFatigue = feedback.filter((f) =>
    (typeof f.rpe === "number" && f.rpe >= 8) ||
    (typeof f.fatigue_rating === "number" && f.fatigue_rating >= 4)).length >= 2;
  const lastAnySport = daysSince(runs.map((r) => r.activity_date), nowMs);

  if (input.anchor) applyPaceAnchor(run, input.anchor, load, input.today, nowMs);

  const name = input.name ?? "";
  return {
    athleteId: 0,
    name,
    firstName: name.split(" ")[0],
    ageYears: computeAgeYears(input.birthDate, input.today),
    sex: normaliseSex(input.sex ?? null),
    weightKg: input.weightKg ?? null,
    experienceLevel: input.experienceLevel ?? null,
    maxHr: input.maxHr ?? null,
    restHr: input.restHr ?? null,
    hrZoneMaxPcts: Array.isArray(input.hrZoneMaxPcts) ? input.hrZoneMaxPcts : null,
    run, bike, swim, weekly,
    load,
    mechanicalRampPct,
    injury: classifyInjury(input.concerns ?? null, input.painLogs ?? null, input.injuryHistory ?? null),
    medical: detectMedicalEscalation(input.concerns ?? null, input.painLogs ?? null),
    missedTraining: missedTrainingAdjustment(lastAnySport),
    recentHighFatigue,
    prefs: readTrainingPreferences(input.preferences),
  };
}

/** Which sports an athlete actually trains, by recent evidence. */
export function activeSports(p: AthleteProfile): ("run" | "bike" | "swim")[] {
  const out: ("run" | "bike" | "swim")[] = [];
  if (p.run.sessions4w > 0) out.push("run");
  if (p.bike.sessions4w > 0) out.push("bike");
  if (p.swim.sessions4w > 0) out.push("swim");
  return out;
}

function applyPaceAnchor(run: RunFitness, d: AnchorData, load: MultisportSummary, today: string, nowMs: number): void {
  const g = d.goal;
  let prediction: Parameters<typeof choosePaceAnchor>[0]["prediction"] = null;
  if (g && g.goal_type !== "improve_fitness") {
    const eventKm = g.goal_distance_m != null && g.goal_distance_m > 0 ? g.goal_distance_m / 1000 : null;
    const weeksToRace = g.race_date ? Math.max(0, Math.round((Date.parse(g.race_date) - nowMs) / (7 * DAY_MS))) : null;
    const p = predictRaceTime({
      goalType: g.goal_type,
      activities: d.predictionRuns,
      ctl: load.ctl > 0 ? load.ctl : null,
      acwr: load.ctl > 0 ? Math.round((load.atl / load.ctl) * 100) / 100 : null,
      weeklyAvgKm: run.weeklyKm || null,
      weeksToRace,
      trainingPhase: "General",
      goalTimeSeconds: g.goal_time_seconds,
      eventDistanceKm: eventKm,
      nowMs,
    });
    if (p) prediction = { predictedSeconds: p.predictedSeconds, confidence: p.confidence, goalType: g.goal_type, eventDistanceKm: eventKm };
  }
  const anchor = choosePaceAnchor({
    today, races: d.races, raceActivities: d.raceActivities, prediction, measuredEasyPace: run.easyPaceSecPerKm,
    benchmarks: d.benchmarks,
  });
  if (!anchor) return;
  run.easyPaceSecPerKm = anchor.easyPaceSecPerKm;
  run.thresholdPaceSecPerKm = anchor.thresholdPaceSecPerKm;
  run.intervalPaceSecPerKm = anchor.intervalPaceSecPerKm;
  run.paceAnchor = { source: anchor.source, basis: anchor.basis };
}
