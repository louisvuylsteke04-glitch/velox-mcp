/**
 * Deterministic training-load model.
 *
 * This module owns all *volume arithmetic* for a training plan. It is pure (no
 * I/O) and unit-testable. It does NOT author or clamp the LLM coach's sessions;
 * it is advisory context:
 *
 *   1. `training_plans.week_targets` — the per-week phase + volume + long-run
 *      cap stored with every plan, read by the calendar-edit route (long-run
 *      caps on raw athlete edits) and the far-week calendar UI.
 *   2. Feasibility telemetry — `feasibility_flagged` coaching events when the
 *      goal looks inadequate for the available time.
 *
 * Science encoded here: anchor week 1 to recent volume, build ≤10%/week, insert
 * a recovery week every 4th week at ~75% of the preceding peak (then resume the
 * ramp from that peak, not from the reduced week), and taper into race week.
 */

import type { GeneratedWeek } from "./types/calendar";
import { raceKmFor } from "./predict/race-predictor";
import { startFromSelfReport, SELF_REPORT_RUN_CAP_KM, THIN_RUN_WEEKS } from "./plan/self-report";

export type Phase = GeneratedWeek["phase"]; // "base" | "build" | "peak" | "taper" | "recovery"

// A race week's volume must cover the race itself plus a couple of easy
// shakeout runs around it; the race is the long effort, not a capped long run.
const RACE_SHAKEOUT_KM = 5;

/** Conservative starting weekly volume (km) for athletes with no run history.
 *  Beginner is deliberately low: a true never-ran athlete opens with run/walk
 *  sessions, not 15 km of running. */
export const EXPERIENCE_START_KM: Record<string, number> = {
  beginner:     12,
  intermediate: 25,
  advanced:     35,
};

/** Distance-appropriate absolute ceilings on peak weekly volume (km).
 *  Multi-sport goals sit ~20% below their standalone running equivalent: the
 *  bike and swim work carries its own systemic load, so the same running volume
 *  on top of it is a different (higher) total stress. */
const PEAK_CAP_KM: Record<string, number> = {
  marathon:        120,
  half_marathon:   90,
  "10k":           70,
  "5k":            55,
  ultra:           160,
  improve_fitness: 90,
  // Triathlon: the run leg's standalone cap, scaled for coexisting bike/swim load.
  triathlon_sprint:  40,
  triathlon_olympic: 50,
  triathlon_half:    70,
  triathlon_full:    95,
  // Bike/swim events: running is a supporting sport, not the point.
  bike_event:        45,
  swim_event:        35,
};

/** Weekly increase cap during build. ≤10% is the textbook safe rule. */
const WEEKLY_RAMP = 1.10;
/** Gentler ramp for masters / when an injury is active. */
const WEEKLY_RAMP_CONSERVATIVE = 1.07;
/** Recovery week volume as a fraction of the preceding peak. A gentle down-week
 *  (80%), not a crash, so the bounce back to working volume is moderate. */
const RECOVERY_FRACTION = 0.80;
/** Insert a recovery week on every Nth week. */
const RECOVERY_EVERY = 4;
/** Masters athletes recover slower: recovery week every 3rd instead of 4th. */
const RECOVERY_EVERY_MASTERS = 3;
/** Age (years) at/above which we treat the athlete as masters for recovery/ramp. */
const MASTERS_AGE = 50;

/**
 * Distance-specific long-run shaping. The long run is the key endurance session
 * and scales very differently by event: a marathon long run is a large share of
 * a moderate week and must reach ~30 km, whereas a 5 k long run is small. Each
 * entry gives the normal share of weekly volume, an absolute ceiling (km), and
 * the peak long run a coach considers minimally adequate to prepare the race.
 */
const LONG_RUN_PARAMS: Record<string, { share: number; absCapKm: number; minForDistanceKm: number }> = {
  "5k":            { share: 0.40, absCapKm: 10, minForDistanceKm: 5 },
  "10k":           { share: 0.35, absCapKm: 16, minForDistanceKm: 9 },
  half_marathon:   { share: 0.42, absCapKm: 22, minForDistanceKm: 18 },
  marathon:        { share: 0.38, absCapKm: 35, minForDistanceKm: 26 },
  ultra:           { share: 0.32, absCapKm: 40, minForDistanceKm: 34 },
  improve_fitness: { share: 0.33, absCapKm: 26, minForDistanceKm: 0 },
  // Triathlon run legs (TRI_LEGS): the long run still has to prepare the leg, but
  // it is run on tired legs off the bike, so the peak sits a little under the
  // standalone equivalent and the weekly share is lower (three sports to fit).
  triathlon_sprint:  { share: 0.35, absCapKm: 12, minForDistanceKm: 6 },
  triathlon_olympic: { share: 0.35, absCapKm: 16, minForDistanceKm: 10 },
  triathlon_half:    { share: 0.38, absCapKm: 24, minForDistanceKm: 18 },
  triathlon_full:    { share: 0.38, absCapKm: 32, minForDistanceKm: 26 },
  // Bike/swim events: running supports durability and aerobic base. No run
  // distance to prepare, so no long-run feasibility requirement.
  bike_event:      { share: 0.33, absCapKm: 16, minForDistanceKm: 0 },
  swim_event:      { share: 0.33, absCapKm: 12, minForDistanceKm: 0 },
};
const DEFAULT_LONG_RUN = { share: 0.33, absCapKm: 26, minForDistanceKm: 0 };

/**
 * Running distance raced on race day, for race-week volume and the race-week
 * long-run cap. Running goals race their own distance; a triathlon races its run
 * leg; a bike or swim event has no run on race day.
 *
 * Deliberately separate from race-predictor's RACE_KM: that table drives the
 * running finish-time prediction, which stays run-only.
 */
function raceRunKm(goalType: string, eventDistanceKm?: number | null): number {
  if (goalType.startsWith("triathlon")) return TRI_LEGS[goalType]?.run ?? 0;
  if (goalType === "bike_event" || goalType === "swim_event") return 0;
  return raceKmFor(goalType, eventDistanceKm) ?? 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The distance ceilings, for a goal whose distance the athlete named.
 *
 * PEAK_CAP_KM and LONG_RUN_PARAMS are guardrails sitting on top of a volume
 * curve that is already the athlete's own (see computeStartingVolume and
 * peakMultipleFor: recent weeks, CTL, ACWR, injury, fatigue, age and layoffs all
 * move it). A guardrail still has to be set for the right race, though, and one
 * `ultra` row set for the top of the range was being applied to a 50 km.
 *
 * So for ultra they become functions of the race distance D:
 *   peak cap      1.7 × D, held between 100 and 190 km/week
 *   long-run cap  0.55 × D, held between 30 and 55 km
 *   ready-at      0.50 × D, held between 26 and 48 km
 * Sublinear and bounded on purpose: nobody prepares a 160 km by running 160 km,
 * and the ceilings stop a 100-miler generating a week no athlete would survive.
 * Every other goal type keeps its table row, and an ultra with no stated
 * distance keeps today's fixed 160 / 40 / 34.
 */
function statedUltraKm(goalType: string, eventDistanceKm?: number | null): number | null {
  if (goalType !== "ultra") return null;
  return eventDistanceKm != null && Number.isFinite(eventDistanceKm) && eventDistanceKm > 0
    ? eventDistanceKm
    : null;
}

function peakCapKmFor(goalType: string, eventDistanceKm?: number | null): number {
  const d = statedUltraKm(goalType, eventDistanceKm);
  if (d == null) return PEAK_CAP_KM[goalType] ?? 100;
  return roundKm(clamp(1.7 * d, 100, 190));
}

function longRunParamsFor(goalType: string, eventDistanceKm?: number | null): { share: number; absCapKm: number; minForDistanceKm: number } {
  const fixed = LONG_RUN_PARAMS[goalType] ?? DEFAULT_LONG_RUN;
  const d = statedUltraKm(goalType, eventDistanceKm);
  if (d == null) return fixed;
  return {
    share: fixed.share,
    absCapKm: roundKm(clamp(0.55 * d, 30, 55)),
    minForDistanceKm: roundKm(clamp(0.50 * d, 26, 48)),
  };
}

/** Base peak-volume multiple by experience, before the gentle plan-length scaling. */
const PEAK_MULTIPLE_BASE: Record<string, number> = {
  beginner:     1.5,
  intermediate: 1.65,
  advanced:     2.0,
};
/**
 * Week-1 volume is damped when the athlete arrives under-recovered or hurt, so
 * the plan opens with a consolidation week instead of an overload. Multiplicative
 * and floored so the de-load is meaningful but never collapses the week.
 */
const DAMP_HIGH_FATIGUE = 0.90;
const DAMP_INJURY_ACTIVE = 0.85;
const DAMP_FLOOR = 0.80;

/** Rough CTL → sustainable weekly-km mapping (CTL is a 42-day training-load EWMA;
 *  empirically ~CTL 50 ≈ 65 km/week for a recreational runner). */
const CTL_TO_WEEKLY_KM = 1.3;
/** A return-to-training restart anchors at this fraction of demonstrated capacity,
 *  so post-race/post-layoff recovery dips do not crater the starting volume. */
const CAPACITY_RESTART_FRACTION = 0.45;

export type LoadModelInput = {
  experienceLevel: string | null;     // 'beginner'|'intermediate'|'advanced'|other|null
  recentWeeklyKm: number;             // mean of recent COMPLETE weeks, 0 when no history
  weeklyKmHistory: number[];          // last ~8 complete weeks, oldest first — used for peak capacity
  recentLongRunKm: number;
  acwr: number | null;
  /** Chronic training load (42-day EWMA). Used as a recovery-robust capacity floor
   *  so a fit athlete in a post-race dip is not anchored to a noisy recent mean. */
  ctl?: number | null;
  totalWeeks: number;
  weeksToRace: number | null;         // null => no race => no taper
  goalType: string;
  /** The athlete's own race distance (km), for goal types that do not imply one.
   *  Today only `ultra`, where 50 km and 160 km are the same goal_type. */
  eventDistanceKm?: number | null;
  priorPlan: {
    weeksElapsed: number;
    lastPhase: string | null;
    weeklyKmAtSwitch: number | null;
  } | null;
  /** Athlete age in years (from date_of_birth). Masters get slower ramp/recovery. */
  ageYears?: number | null;
  /** True when recent feedback shows repeated high fatigue or RPE — week 1 is damped. */
  recentHighFatigue?: boolean;
  /** True when a current injury/pain concern is active — gentler ramp + damped week 1. */
  injuryActive?: boolean;
  /** Multiplier (0.5–1.0) applied to week-1 volume when training was recently
   *  missed (return-to-training). 1.0 = no gap. See missedTrainingAdjustment(). */
  missedTrainingFactor?: number;
  /** Weekly km the athlete reported at sign-up, passed only under
   *  SELF_REPORT_START. Used when the synced history is thin (#121, C1). */
  selfReportedWeeklyKm?: number | null;
};

export type WeekTarget = {
  week_number: number;
  phase: Phase;
  target_weekly_km: number;
  is_recovery_week: boolean;
  long_run_cap_km: number;
  /**
   * Cross-sport ceilings, present on plans built by the multi-sport engine
   * (lib/plan). They exist so an athlete's own calendar edits are bounded in
   * every sport, not just running: without them a rider could drag a two-hour
   * ride to eight hours and nothing would question it.
   */
  long_ride_cap_h?: number;
  bike_hours?: number;
  swim_cap_m?: number;
};

export type LoadCurve = {
  startingWeeklyKm: number;
  weeks: WeekTarget[];
  rationale: string;
  noHistory: boolean;
  /** Whether the plan can build the long run far enough to prepare the race
   *  distance safely. When not adequate, `note` is an honest coach caveat. */
  feasibility: { adequate: boolean; note: string | null };
};

function normaliseExperience(level: string | null): keyof typeof EXPERIENCE_START_KM {
  const l = (level ?? "").toLowerCase();
  if (l.includes("begin") || l.includes("new") || l.includes("novice")) return "beginner";
  if (l.includes("adv") || l.includes("elite") || l.includes("experien")) return "advanced";
  return "intermediate";
}

/** Phase ordering used to bias mid-cycle regenerations forward. */
const PHASE_RANK: Record<string, number> = { base: 0, build: 1, peak: 2 };

/**
 * Compute a safe starting weekly volume — capacity-aware so a fit athlete in a
 * recovery dip is not anchored to a noisy recent mean.
 *
 *  - Recent mean is the primary anchor (already excludes the partial current week).
 *  - But it is floored by a fraction of DEMONSTRATED CAPACITY (recent peak week
 *    and CTL-implied volume), tied to a real recent week, so post-marathon /
 *    post-layoff weeks-off do not drag a marathon-fit runner down to ~6 km.
 *  - High ACWR backs the mean off ~10%. No signal at all → experience default.
 */
export function computeStartingVolume(input: LoadModelInput): number {
  const { recentWeeklyKm, acwr, priorPlan, experienceLevel, weeklyKmHistory, ctl } = input;

  // Recent mean (ACWR-adjusted) and any mid-cycle switch volume.
  let mean = recentWeeklyKm > 0 ? recentWeeklyKm : 0;
  if (mean > 0 && acwr != null && acwr > 1.3) mean *= 0.9;
  const switchKm = priorPlan?.weeklyKmAtSwitch && priorPlan.weeklyKmAtSwitch > 0 ? priorPlan.weeklyKmAtSwitch : 0;

  // Demonstrated capacity: the best recent complete week and a CTL-implied volume.
  // A single non-zero week in the history is not a demonstrated pattern, it is
  // one logged run standing in for "capacity" — found on a real athlete whose
  // only activity in eight weeks was one 10 km run seven weeks before a 40-day
  // injury layoff. That one data point was read as "recent peak week 10 km",
  // producing a restart floor of 4.5 km/week for an intermediate runner: far
  // below even the beginner experience default (12), and low enough that the
  // schedule solver went on to prescribe sub-kilometre "sessions". Capacity
  // evidence needs at least two non-zero weeks — an actual established pattern —
  // before it is allowed to override the safe experience-based default below.
  const nonZeroWeeks = weeklyKmHistory.filter((km) => km > 0).length;

  // Thin synced history and a sign-up report (#121, C1): the report anchors the
  // start instead of the experience default or one stray logged run. A
  // mid-cycle switch volume is real evidence and still wins.
  if (nonZeroWeeks < THIN_RUN_WEEKS && switchKm <= 0) {
    const exp = normaliseExperience(experienceLevel);
    const fromReport = startFromSelfReport(input.selfReportedWeeklyKm, EXPERIENCE_START_KM[exp], SELF_REPORT_RUN_CAP_KM[exp]);
    if (fromReport != null) return Math.max(1, Math.round(Math.max(fromReport, mean)));
  }

  const peakRecent = nonZeroWeeks >= 2 ? Math.max(...weeklyKmHistory) : 0;
  const ctlImplied = ctl != null && ctl > 5 ? ctl * CTL_TO_WEEKLY_KM : 0;
  const capacity = Math.max(peakRecent, ctlImplied);

  // No signal anywhere → experience default.
  if (mean <= 0 && capacity <= 0 && switchKm <= 0) {
    return EXPERIENCE_START_KM[normaliseExperience(experienceLevel)];
  }

  // Restart floor: a fraction of capacity, but never above 70% of an actual recent
  // week (tie the restart to real running, not just CTL).
  let capacityFloor = capacity * CAPACITY_RESTART_FRACTION;
  if (peakRecent > 0) capacityFloor = Math.min(capacityFloor, peakRecent * 0.7);

  return Math.max(1, Math.round(Math.max(mean, capacityFloor, switchKm)));
}

function taperLengthFor(goalType: string, weeksToRace: number | null, totalWeeks: number): number {
  if (weeksToRace === null) return 0; // no race, no taper
  // Long events need a longer taper: the accumulated fatigue takes more than a
  // fortnight to shed. Full-distance triathlon sits with the marathon/ultra.
  const LONG_TAPER = new Set(["marathon", "ultra", "triathlon_full"]);
  const base = LONG_TAPER.has(goalType) ? 3 : 2;
  // Never taper away the whole plan; leave at least one build week.
  return Math.min(base, Math.max(0, totalWeeks - 1));
}

/** Taper multipliers (applied to the pre-taper peak), longest taper first. */
function taperMultipliers(len: number): number[] {
  if (len <= 0) return [];
  if (len === 1) return [0.6];
  if (len === 2) return [0.7, 0.55];
  return [0.75, 0.6, 0.5]; // 3-week taper into race week
}

function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}

/**
 * Long-run cap for a week, distance-aware. Normally `share` of weekly volume,
 * but early non-recovery weeks may go up to the athlete's *current* long-run
 * ability, so we never force a runner already doing 16 km long runs down to a
 * 12 km one because an early week is light. Bounded by an absolute ceiling.
 * Recovery weeks keep the plain share so the deload lands on the long run too.
 */
function longRunCapKm(
  target: number,
  recentLongRunKm: number,
  isRecovery: boolean,
  share: number,
  absCapKm: number,
): number {
  const base = target * share;
  let cap = base;
  if (!isRecovery && recentLongRunKm > 0) {
    const abilityFloor = Math.min(recentLongRunKm, target * (share + 0.10));
    cap = Math.max(base, abilityFloor);
  }
  return roundKm(Math.min(cap, absCapKm));
}

/**
 * Peak-volume multiple over the starting volume. Scales with experience and plan
 * length: a longer plan can safely build to a higher multiple at 10%/week, and
 * experienced runners tolerate a higher ceiling than beginners. The absolute
 * distance cap (PEAK_CAP_KM) still applies on top of this.
 */
function peakMultipleFor(experience: keyof typeof EXPERIENCE_START_KM, buildWeeks: number, baseStartKm: number): number {
  const base = PEAK_MULTIPLE_BASE[experience] ?? 1.65;
  // Gentle: longer plans earn a little more headroom, short plans a little less.
  const lengthFactor = Math.max(0.85, Math.min(1.4, 0.9 + (buildWeeks - 10) * 0.025));
  // Attenuate for already-high-volume runners: someone at 80 km/week should add
  // ~30-40 km, not double. The "extra" volume above the start is what shrinks, so
  // low-base runners (returning, rebuilding) still get an aggressive multiple.
  const baseAtten = Math.max(0.5, Math.min(1.0, 40 / Math.max(1, baseStartKm)));
  const mult = 1 + (base - 1) * lengthFactor * baseAtten;
  return Math.max(1.3, Math.min(3.0, mult));
}

/**
 * Honest feasibility check: can the plan build the long run far enough to
 * prepare the race distance? If the peak long run falls short of the
 * distance-appropriate minimum, return a coach-style caveat for plan_notes.
 */
function computeFeasibility(
  weeks: WeekTarget[],
  goalType: string,
  recentLongRunKm: number,
  params: { minForDistanceKm: number } | undefined,
  eventDistanceKm?: number | null,
): { adequate: boolean; note: string | null } {
  if (!params || params.minForDistanceKm <= 0 || weeks.length === 0) return { adequate: true, note: null };
  // Prepared if the plan's peak long run OR the athlete's current long-run ability
  // already reaches the distance minimum (a short plan for an already-fit runner
  // is feasible).
  const longRunPeak = Math.max(...weeks.map((w) => w.long_run_cap_km), recentLongRunKm || 0);
  if (longRunPeak >= params.minForDistanceKm) return { adequate: true, note: null };
  // Name the actual race. "a ultra" told a 50 km runner nothing; "a 50 km ultra"
  // is the distance they are being warned they are short for.
  const statedKm = statedUltraKm(goalType, eventDistanceKm);
  const label = statedKm != null ? `${roundKm(statedKm)} km ultra` : goalType.replace(/_/g, " ");
  return {
    adequate: false,
    note: `This plan can only build the long run to about ${roundKm(longRunPeak)} km, but safely racing a ${label} needs roughly ${params.minForDistanceKm} km. The current volume and time available are not enough to fully prepare the distance. A longer runway, a shorter goal race for now, or a finish-focused (not time-focused) effort would be safer.`,
  };
}

/**
 * Build the full week-by-week volume curve for the plan horizon.
 */
export function buildLoadCurve(input: LoadModelInput): LoadCurve {
  const totalWeeks = Math.max(1, input.totalWeeks);
  const noHistory = !(input.recentWeeklyKm > 0) && !(input.priorPlan?.weeklyKmAtSwitch);

  // Readiness damping: open with a consolidation week when the athlete arrives
  // under-recovered or hurt, instead of an overload week. The peak ceiling is
  // computed from the *undamped* capacity so a transient dip does not cap the
  // whole build — later weekly regenerations lift it as the athlete recovers.
  const baseStart = computeStartingVolume(input);
  let damp = 1;
  if (input.recentHighFatigue) damp *= DAMP_HIGH_FATIGUE;
  if (input.injuryActive)      damp *= DAMP_INJURY_ACTIVE;
  damp = Math.max(DAMP_FLOOR, damp);
  // Return-to-training cut (a real ≥1-week layoff) takes over rather than
  // compounding on top of the fatigue/injury damp — whichever reduction is
  // deeper wins, so signals do not multiply into an over-suppressed week 1.
  if (input.missedTrainingFactor != null && input.missedTrainingFactor < 1) {
    damp = Math.min(damp, input.missedTrainingFactor);
  }
  const startingWeeklyKm = Math.max(1, Math.round(baseStart * damp));
  const damped = startingWeeklyKm < baseStart;

  // Age- and injury-aware progression: masters and injured athletes ramp more
  // gently and (masters) take a recovery week one week sooner.
  const isMasters = input.ageYears != null && input.ageYears >= MASTERS_AGE;
  const weeklyRamp   = isMasters || input.injuryActive ? WEEKLY_RAMP_CONSERVATIVE : WEEKLY_RAMP;
  const recoveryEvery = isMasters ? RECOVERY_EVERY_MASTERS : RECOVERY_EVERY;

  const taperLen = taperLengthFor(input.goalType, input.weeksToRace, totalWeeks);
  const buildWeeks = totalWeeks - taperLen;

  const experience = normaliseExperience(input.experienceLevel);
  const peakCapAbs = peakCapKmFor(input.goalType, input.eventDistanceKm);
  // Never let the peak fall below the starting volume: an athlete already running
  // above the distance's typical cap (e.g. a 60 km/wk base aiming at a 5k, cap 55)
  // should hold their base while sharpening, not be ramped DOWN week over week.
  const peakCap = Math.max(
    startingWeeklyKm,
    roundKm(Math.min(baseStart * peakMultipleFor(experience, buildWeeks, baseStart), peakCapAbs)),
  );

  const lrp = longRunParamsFor(input.goalType, input.eventDistanceKm);

  // Bias phases forward when regenerating mid-cycle so we don't reset to base.
  const phaseFloor = input.priorPlan?.lastPhase
    ? PHASE_RANK[input.priorPlan.lastPhase] ?? 0
    : 0;

  const weeks: WeekTarget[] = [];
  let peak = startingWeeklyKm; // rolling progression value (excludes recovery dips)
  let prevWasRecovery = false;

  for (let w = 1; w <= buildWeeks; w++) {
    const isRecovery = w > 1 && w % recoveryEvery === 0;

    let target: number;
    if (w === 1) {
      target = startingWeeklyKm;
      peak = target;
    } else if (isRecovery) {
      target = roundKm(peak * RECOVERY_FRACTION); // gentle down-week; peak unchanged
    } else if (prevWasRecovery) {
      // First week back after a deload: return to the established working volume,
      // do NOT also add a ramp on top — that would be a sharp single-week spike.
      target = Math.min(roundKm(peak), peakCap);
    } else {
      target = Math.min(roundKm(peak * weeklyRamp), peakCap);
      peak = target;
    }
    prevWasRecovery = isRecovery;

    // Positional phase across the build portion, biased forward for regen.
    const frac = buildWeeks > 1 ? (w - 1) / (buildWeeks - 1) : 1;
    const positional = frac < 0.4 ? 0 : frac < 0.8 ? 1 : 2;
    const rank = Math.max(positional, phaseFloor);
    const positionalPhase: Phase = rank >= 2 ? "peak" : rank === 1 ? "build" : "base";
    const phase: Phase = isRecovery ? "recovery" : positionalPhase;

    weeks.push({
      week_number: w,
      phase,
      target_weekly_km: target,
      is_recovery_week: isRecovery,
      long_run_cap_km: longRunCapKm(target, input.recentLongRunKm, isRecovery, lrp.share, lrp.absCapKm),
    });
  }

  // Taper weeks ramp down off the pre-taper peak, ending on race week.
  const mult = taperMultipliers(taperLen);
  const raceKm = input.weeksToRace != null ? raceRunKm(input.goalType, input.eventDistanceKm) : 0;
  for (let i = 0; i < taperLen; i++) {
    const w = buildWeeks + i + 1;
    // The final taper week IS the race week. Its volume must cover the race
    // distance + a small shakeout, and the long-run cap is the race distance
    // itself (otherwise the race would be capped to ~30% of a tiny taper week).
    const isRaceWeek = i === taperLen - 1 && raceKm > 0;
    const target = isRaceWeek
      ? roundKm(Math.max(peak * mult[i], raceKm + RACE_SHAKEOUT_KM))
      : roundKm(peak * mult[i]);
    weeks.push({
      week_number: w,
      phase: "taper",
      target_weekly_km: target,
      is_recovery_week: false,
      long_run_cap_km: isRaceWeek ? roundKm(raceKm) : longRunCapKm(target, input.recentLongRunKm, true, lrp.share, lrp.absCapKm),
    });
  }

  // ── Long-run spike control ───────────────────────────────────────────────
  // The long run must not jump too far above the athlete's recent longest run,
  // week to week — independent of weekly volume. Healthy: +12.5%/wk. Under
  // fatigue/injury the FIRST long run is reduced, then rebuilt at the same rate.
  // Recovery/taper weeks reduce the long run anyway and are exempt from the cap.
  {
    const startRatio = input.injuryActive ? 0.80 : input.recentHighFatigue ? 0.90 : 1.125;
    const STEP = 1.125;
    let peakLong = input.recentLongRunKm > 0 ? roundKm(input.recentLongRunKm * startRatio) : 0;
    let firstBuildWeek = true;
    for (const w of weeks) {
      if (w.is_recovery_week || w.phase === "taper") continue;
      if (peakLong > 0) {
        const ceiling = firstBuildWeek ? peakLong : roundKm(peakLong * STEP);
        if (w.long_run_cap_km > ceiling) w.long_run_cap_km = ceiling;
      }
      peakLong = Math.max(peakLong, w.long_run_cap_km);
      firstBuildWeek = false;
    }
  }

  // Feasibility measures whether TRAINING prepares the distance, so exclude the
  // race week (its "long run" is the race itself, which would trivially satisfy
  // the distance and hide an under-prepared plan).
  const feasibilityWeeks = raceKm > 0 ? weeks.slice(0, -1) : weeks;
  const feasibility = computeFeasibility(feasibilityWeeks, input.goalType, input.recentLongRunKm, lrp, input.eventDistanceKm);

  const taperNote = taperLen > 0 ? ` with a ${taperLen}-week taper into race week` : "";
  const anchorNote = noHistory
    ? `no run history on file, starting conservatively at ${startingWeeklyKm} km/week for a ${normaliseExperience(input.experienceLevel)} runner`
    : `starting at ${startingWeeklyKm} km/week (anchored to recent volume)`;
  const readinessNote = damped
    ? `, opening with a consolidation week (${input.injuryActive ? "active injury" : ""}${input.injuryActive && input.recentHighFatigue ? " + " : ""}${input.recentHighFatigue ? "recent high fatigue" : ""})`
    : "";
  const rampPct = Math.round((weeklyRamp - 1) * 100);
  const recoveryOrdinal = recoveryEvery === 3 ? "3rd" : "4th";
  const mastersNote = isMasters ? " (masters progression)" : "";
  const rationale = `${anchorNote}${readinessNote}, building no more than ${rampPct}% per week with a recovery week every ${recoveryOrdinal} week${mastersNote}${taperNote}.`;

  return { startingWeeklyKm, weeks, rationale, noHistory, feasibility };
}

// ── Cross-sport envelopes (bike / swim / triathlon goals) ─────────────────────

/** Triathlon leg distances (km) by goal type. */
export const TRI_LEGS: Record<string, { swim: number; bike: number; run: number }> = {
  triathlon_sprint:  { swim: 0.75, bike: 20,  run: 5 },
  triathlon_olympic: { swim: 1.5,  bike: 40,  run: 10 },
  triathlon_half:    { swim: 1.9,  bike: 90,  run: 21.1 },
  triathlon_full:    { swim: 3.8,  bike: 180, run: 42.2 },
};

/** Weekly-hours ramp for cycling: hours build gentler than run km. */
const BIKE_RAMP = 1.08;
/** Starting weekly bike hours when there is no ride history. */
const BIKE_START_HOURS: Record<string, number> = { beginner: 3, intermediate: 5, advanced: 7 };
/** Longest ride: normal share of weekly hours, ceiling, and the event-readiness rule. */
const LONG_RIDE_SHARE = 0.45;
const LONG_RIDE_ABS_CAP_H = 6;
/** The longest ride should reach ~70% of the event's expected duration. */
const LONG_RIDE_EVENT_FRACTION = 0.7;
/** Weekly swim volume ceiling (km) per triathlon distance. */
const SWIM_WEEK_CAP_KM: Record<string, number> = {
  triathlon_sprint: 3, triathlon_olympic: 5, triathlon_half: 7, triathlon_full: 10, swim_event: 12,
};

export type CrossEnvelopeWeek = {
  week_number: number;
  bike_hours: number | null;
  long_ride_hours: number | null;
  swim_km: number | null;
};

export type CrossEnvelope = {
  weeks: CrossEnvelopeWeek[];
  /** Estimated event (or bike-leg) duration in hours, when derivable. */
  eventHours: number | null;
  feasibility: { adequate: boolean; note: string | null };
  rationale: string;
};

export type CrossEnvelopeInput = {
  goalType: string;               // bike_event | swim_event | triathlon_*
  /** Bike event distance (km) from the goal's race details; tri legs come from TRI_LEGS. */
  eventDistanceKm: number | null;
  recentBikeHoursWeekly: number;  // mean of last 4 weeks
  recentLongRideHours: number;    // longest single ride, last 6 weeks
  recentBikeSpeedKmh: number | null;
  recentSwimKmWeekly: number;
  experienceLevel: string | null;
  totalWeeks: number;
  weeksToRace: number | null;
  ageYears?: number | null;
  injuryActive?: boolean;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Deterministic weekly envelopes for the bike and swim sides of a bike, swim, or
 * triathlon goal. Same skeleton as the run curve: anchor to recent volume, ramp
 * gently (8%/week in hours), recovery week every 4th (3rd for masters), taper
 * into race week, and progress the long ride toward ~70% of the event duration.
 * Returns null for run-only goals.
 */
export function buildCrossEnvelope(input: CrossEnvelopeInput): CrossEnvelope | null {
  const isTri = input.goalType.startsWith("triathlon");
  const isBikeGoal = input.goalType === "bike_event";
  const isSwimGoal = input.goalType === "swim_event";
  if (!isTri && !isBikeGoal && !isSwimGoal) return null;

  const totalWeeks = Math.max(1, input.totalWeeks);
  const experience = normaliseExperience(input.experienceLevel);
  const isMasters = input.ageYears != null && input.ageYears >= MASTERS_AGE;
  const recoveryEvery = isMasters ? RECOVERY_EVERY_MASTERS : RECOVERY_EVERY;
  const taperLen = input.weeksToRace != null ? Math.min(2, Math.max(0, totalWeeks - 1)) : 0;
  const buildWeeks = totalWeeks - taperLen;

  // Event duration estimate (bike event or triathlon bike leg).
  const legKm = isTri ? TRI_LEGS[input.goalType]?.bike ?? null : isBikeGoal ? input.eventDistanceKm : null;
  const speed = input.recentBikeSpeedKmh != null && input.recentBikeSpeedKmh >= 18 && input.recentBikeSpeedKmh <= 42
    ? input.recentBikeSpeedKmh
    : 27;
  const eventHours = legKm != null && legKm > 0 ? r1(legKm / speed) : null;

  const wantsBike = isTri || isBikeGoal;
  const wantsSwim = isTri || isSwimGoal;

  // Bike weekly-hours curve.
  let bikeStart = input.recentBikeHoursWeekly > 0
    ? input.recentBikeHoursWeekly
    : (BIKE_START_HOURS[experience] ?? 5) * (isTri ? 0.6 : 1);
  bikeStart = Math.max(1.5, r1(bikeStart));
  const bikePeakCap = Math.min(
    (isTri ? 10 : 14) * (experience === "advanced" ? 1.2 : experience === "beginner" ? 0.75 : 1),
    Math.max(bikeStart * 1.8, bikeStart + 3),
  );

  // Long-ride readiness target: ~70% of event duration, hard-capped.
  const longRideGoalH = eventHours != null
    ? Math.min(LONG_RIDE_ABS_CAP_H, r1(eventHours * LONG_RIDE_EVENT_FRACTION))
    : null;

  // Swim weekly-km curve.
  const swimLegKm = isTri ? TRI_LEGS[input.goalType]?.swim ?? null : isSwimGoal ? input.eventDistanceKm : null;
  const swimCap = SWIM_WEEK_CAP_KM[input.goalType] ?? 5;
  let swimStart = input.recentSwimKmWeekly > 0 ? input.recentSwimKmWeekly : Math.min(1.5, swimCap);
  swimStart = Math.max(0.8, r1(swimStart));

  const weeks: CrossEnvelopeWeek[] = [];
  let bikePeak = bikeStart;
  let swimPeak = swimStart;
  /** Longest ride the build actually reaches; the taper shrinks from this. */
  let longRidePeak = 0;
  let prevRecovery = false;
  const ramp = input.injuryActive || isMasters ? 1.06 : BIKE_RAMP;

  for (let w = 1; w <= buildWeeks; w++) {
    const isRecovery = w > 1 && w % recoveryEvery === 0;
    let bikeH = bikePeak;
    let swimK = swimPeak;
    if (w === 1) { bikeH = bikeStart; swimK = swimStart; }
    else if (isRecovery) { bikeH = bikePeak * RECOVERY_FRACTION; swimK = swimPeak * RECOVERY_FRACTION; }
    else if (prevRecovery) { bikeH = bikePeak; swimK = swimPeak; }
    else {
      bikeH = Math.min(bikePeak * ramp, bikePeakCap);
      swimK = Math.min(swimPeak * 1.10, swimCap);
      bikePeak = bikeH;
      swimPeak = swimK;
    }
    prevRecovery = isRecovery;

    // Long ride climbs with the week, respecting recovery deloads and the event goal.
    const longRide = wantsBike
      ? r1(Math.min(
          Math.max(bikeH * LONG_RIDE_SHARE, input.recentLongRideHours > 0 && !isRecovery ? Math.min(input.recentLongRideHours, bikeH * 0.6) : 0),
          longRideGoalH ?? LONG_RIDE_ABS_CAP_H,
          LONG_RIDE_ABS_CAP_H,
        ))
      : null;
    if (longRide != null && !isRecovery) longRidePeak = Math.max(longRidePeak, longRide);

    weeks.push({
      week_number: w,
      bike_hours: wantsBike ? r1(bikeH) : null,
      long_ride_hours: longRide,
      swim_km: wantsSwim ? r1(swimK) : null,
    });
  }

  // Taper: 70% then 55% of peak weekly hours, and the long ride SHRINKS from the
  // build's longest, never grows past it. Deriving the taper long ride from a
  // share of weekly hours (as this used to) inverted the block: a 12 h peak week
  // produced a 3.8 h "long ride" in the taper against 2.2 h in the build, i.e. the
  // single biggest ride of the plan landed in the week meant to shed fatigue.
  const mults = taperLen === 2 ? [0.7, 0.55] : taperLen === 1 ? [0.6] : [];
  for (let i = 0; i < taperLen; i++) {
    const w = buildWeeks + i + 1;
    const isRaceWeek = i === taperLen - 1;
    // Race week: the event itself is the long ride. For a bike event that means
    // the full event duration; for a triathlon the ride sits INSIDE the race, so
    // no separate long ride is prescribed at all.
    const raceWeekLongRide = isBikeGoal && eventHours != null ? eventHours : null;
    weeks.push({
      week_number: w,
      bike_hours: wantsBike ? r1(Math.max(bikePeak * mults[i], isRaceWeek && eventHours != null ? eventHours + 1 : 0)) : null,
      long_ride_hours: !wantsBike ? null
        : isRaceWeek ? raceWeekLongRide
        : r1(Math.min(longRidePeak * mults[i], longRidePeak)),
      swim_km: wantsSwim ? r1(Math.max(swimPeak * mults[i], isRaceWeek && swimLegKm != null ? swimLegKm : 0)) : null,
    });
  }

  // Feasibility: can the long ride reach the event-readiness fraction in time?
  let feasibility: CrossEnvelope["feasibility"] = { adequate: true, note: null };
  if (wantsBike && longRideGoalH != null) {
    const buildOnly = taperLen > 0 ? weeks.slice(0, -1) : weeks;
    const peakLongRide = Math.max(...buildOnly.map((w) => w.long_ride_hours ?? 0), input.recentLongRideHours || 0);
    if (peakLongRide + 0.05 < longRideGoalH) {
      feasibility = {
        adequate: false,
        note: `The longest ride only builds to about ${r1(peakLongRide)} h, but this event (est. ${eventHours} h) wants a longest ride near ${longRideGoalH} h. More runway or more weekly riding time would prepare it properly.`,
      };
    }
  }

  const parts: string[] = [];
  if (wantsBike) parts.push(`bike from ${r1(bikeStart)} h/week toward ${r1(bikePeak)} h with the long ride climbing to ${r1(Math.min(longRideGoalH ?? LONG_RIDE_ABS_CAP_H, LONG_RIDE_ABS_CAP_H))} h`);
  if (wantsSwim) parts.push(`swim from ${r1(swimStart)} km/week toward ${r1(swimPeak)} km`);
  const rationale = `Cross-sport envelope: ${parts.join("; ")}, ramping about ${Math.round((ramp - 1) * 100)}%/week in time with the same recovery rhythm as the run curve.`;

  return { weeks, eventHours, feasibility, rationale };
}
