/**
 * The running side of a plan.
 *
 * This deliberately WRAPS lib/plan-load-model.ts rather than reimplementing it.
 * That curve is the most mature part of the system: it is what the 17-persona
 * rubric in scripts/plan-tests.ts guards, and running is the sport Velox is
 * already good at. Rewriting it to look symmetrical with the bike and swim
 * envelopes would risk the one thing that must not regress.
 *
 * What this module adds is the multi-sport context the run curve cannot know:
 *  - a support role, where running holds durability for a cyclist or swimmer and
 *    must not behave like a race build;
 *  - the run-off-the-bike demand of a triathlon, where the long run matters but
 *    the legs arrive at it already loaded.
 */

import { buildLoadCurve, type LoadModelInput } from "../plan-load-model";
import type { Phase, RunWeek, SportRole } from "./types";
import { runWeekTss } from "./types";

/** Weekly volume for running kept purely as a support sport, by experience. It is
 *  enough to hold impact tolerance and aerobic durability, not to build a race. */
const SUPPORT_WEEK_KM: Record<string, number> = { beginner: 10, intermediate: 18, advanced: 25 };
/** A support runner's long run stays modest: durability, not endurance building. */
const SUPPORT_LONG_RUN_SHARE = 0.4;

export type RunEnvelopeInput = {
  role: SportRole;
  experience: "beginner" | "intermediate" | "advanced";
  /** Mean weekly km over the last 4 complete weeks. */
  recentWeeklyKm: number;
  weeklyKmHistory: number[];
  recentLongRunKm: number;
  easyPaceSecPerKm: number | null;
  /** Combined-sport fitness, so the anchor sees all the athlete's training. */
  ctl: number | null;
  acwr: number | null;
  goalType: string;
  /** The athlete's own race distance (km), for goal types that do not imply one
   *  (today: ultra). Sizes the peak cap, the long run and race week. */
  eventDistanceKm: number | null;
  totalWeeks: number;
  weeksToRace: number | null;
  ageYears: number | null;
  recentHighFatigue: boolean;
  injuryActive: boolean;
  missedTrainingFactor: number;
  sessions: number;
  phases: { phase: Phase; isRecovery: boolean; taperMultiplier: number | null }[];
  /** Sign-up weekly km, passed only when SELF_REPORT_START is on (#121, C1). */
  selfReportedWeeklyKm?: number | null;
};

export type RunEnvelopeResult = {
  weeks: (RunWeek | null)[];
  /** The curve's own feasibility read (can the long run prepare the distance). */
  verdict: { adequate: boolean; note: string | null };
  rationale: string;
};

export function buildRunEnvelope(input: RunEnvelopeInput): RunEnvelopeResult {
  if (input.role === "off") {
    return { weeks: input.phases.map(() => null), verdict: { adequate: true, note: null }, rationale: "" };
  }

  if (input.role === "support") {
    // Supporting running is a flat, modest commitment that tracks the deload
    // rhythm of the plan. It does not build toward anything, so it does not ramp.
    const base = input.recentWeeklyKm > 0
      ? Math.min(input.recentWeeklyKm, SUPPORT_WEEK_KM[input.experience] ?? 18)
      : (SUPPORT_WEEK_KM[input.experience] ?? 18) * 0.6;
    const weeks = input.phases.map(({ isRecovery, taperMultiplier }) => {
      const factor = taperMultiplier != null ? Math.min(taperMultiplier, 0.6) : isRecovery ? 0.75 : 1;
      const km = Math.round(base * factor * 10) / 10;
      return {
        km,
        longRunKm: Math.round(km * SUPPORT_LONG_RUN_SHARE * 10) / 10,
        sessions: input.sessions,
        tss: runWeekTss(km, input.easyPaceSecPerKm),
      };
    });
    return {
      weeks,
      verdict: { adequate: true, note: null },
      rationale: `running held at about ${Math.round(base)} km/week for durability alongside the main sport`,
    };
  }

  // Primary running: the existing, rubric-guarded curve owns every number.
  const curveInput: LoadModelInput = {
    experienceLevel: input.experience,
    recentWeeklyKm: input.recentWeeklyKm,
    weeklyKmHistory: input.weeklyKmHistory,
    recentLongRunKm: input.recentLongRunKm,
    acwr: input.acwr,
    ctl: input.ctl,
    totalWeeks: input.totalWeeks,
    weeksToRace: input.weeksToRace,
    goalType: input.goalType,
    eventDistanceKm: input.eventDistanceKm,
    priorPlan: null,
    ageYears: input.ageYears,
    recentHighFatigue: input.recentHighFatigue,
    injuryActive: input.injuryActive,
    missedTrainingFactor: input.missedTrainingFactor,
    selfReportedWeeklyKm: input.selfReportedWeeklyKm ?? null,
  };
  const curve = buildLoadCurve(curveInput);

  const weeks: (RunWeek | null)[] = input.phases.map((_, i) => {
    const w = curve.weeks[i];
    if (!w) return null;
    return {
      km: w.target_weekly_km,
      longRunKm: w.long_run_cap_km,
      sessions: input.sessions,
      tss: runWeekTss(w.target_weekly_km, input.easyPaceSecPerKm),
    };
  });

  return { weeks, verdict: curve.feasibility, rationale: curve.rationale };
}

/** What the running quality is for in each phase, by event. */
export function runQualityForPhase(phase: Phase, goalType: string): string {
  const shortEvent = goalType === "5k" || goalType === "10k" || goalType === "triathlon_sprint";
  switch (phase) {
    case "base":     return "strides and hills for mechanics, one steady or tempo run, everything else easy";
    case "build":    return shortEvent
      ? "intervals at 5k-10k effort, plus a tempo run"
      : "threshold and tempo work, long run steady";
    case "peak":     return shortEvent
      ? "sharper intervals at race effort, race-pace repeats"
      : "race-pace segments in the long run, threshold volume held";
    case "taper":    return "short race-pace touches, volume down, legs kept fresh";
    case "recovery": return "easy running only";
  }
}
