/**
 * Build a training plan. The web app's hybrid generation path
 * (lib/training-plan.ts authorPlan + generateAndStorePlan), with the database
 * and the blueprint LLM call removed:
 *
 *   envelope → blueprint → expand → run-only → invariant check and safe repair
 *   → coach cues → structured sessions → assessment week → race-day pin → dated sessions
 *
 * The blueprint (weekly shape, quality progression, long-run texture) is the
 * coach's call. In the web app an LLM wrote it; in velox-mcp Claude writes it
 * and passes it in, and without one the engine's own deterministic default is
 * used, exactly as the web app fell back when its LLM call failed.
 *
 * Feature flags from the web app are fixed at their preview values: run-only
 * sessions, pace anchors, self-report start, coach guidance, structured
 * sessions and the assessment week are all on.
 */
import type { GeneratedPlan, PaceZone, SessionSegment, WorkoutType } from "../types/calendar";
import type { AthleteProfile } from "./profile";
import type { PlanEnvelope } from "./types";
import { buildPlanEnvelope } from "./periodize";
import { defaultBlueprint, parseBlueprint, blueprintBrief, type Blueprint } from "./blueprint";
import { expandPlan, validatePlan } from "./expand";
import { stripNonRunSessions } from "./run-only";
import { checkPlan, repairPlan, type Violation } from "./invariants";
import { toStoredBlueprint, sessionGuidance } from "./guidance";
import { structurePlan } from "./workouts";
import { applyAssessmentWeek } from "./assessment";
import { neutralTitle, pinRaceSession } from "./race-day";
import { raceKmFor } from "../predict/race-predictor";
import { addDaysYMD, mondayOfWeekYMD, nextMondayOnOrAfterYMD, raceSlotYMD } from "../dates";

/** Appended to plan_notes when run paces rest on easy-pace ratios alone. */
export const ESTIMATED_PACES_NOTE = "Your training paces are estimated from your easy runs for now. A race or a time trial will sharpen them.";

export type PlanGoal = {
  type: string;
  raceDate: string | null;
  /** Only for ultra: the athlete's own race distance. */
  eventDistanceKm: number | null;
  targetTimeSecs: number | null;
};

export type BuildPlanInput = {
  profile: AthleteProfile;
  goal: PlanGoal | null;
  today: string;
  /** Requested first day; snapped to its Monday. Ignored when in the past. */
  startDate?: string | null;
  /** The coach's blueprint (object or JSON text). Null uses the engine default. */
  blueprint?: unknown;
  /** First plan for this athlete: week 1 becomes an assessment week. */
  assessment: boolean;
  /** The athlete's own request for this plan, quoted to the coach as data. */
  constraint?: string | null;
};

export type DatedSession = {
  date: string;
  week_number: number;
  day_of_week: number;
  title: string;
  workout_type: WorkoutType;
  target_distance_km: number | null;
  target_duration_min: number | null;
  target_pace_zone: PaceZone | null;
  description: string | null;
  coach_cue: string | null;
  segments: SessionSegment[] | null;
  pinned: boolean;
};

export type BuildPlanResult = {
  planStart: string;
  totalWeeks: number;
  weeksToRace: number | null;
  envelope: PlanEnvelope;
  blueprint: Blueprint;
  blueprintSource: "coach" | "fallback";
  /** Set when a blueprint was passed in but could not be used. */
  blueprintRejected: boolean;
  plan: GeneratedPlan;
  sessions: DatedSession[];
  /** Invariant findings before the race is pinned, exactly as the web app logged them. */
  violations: Violation[];
  /** The same check re-run on the finished plan: what is actually still wrong. */
  finalViolations: Violation[];
  repaired: string[];
  structuralProblems: string[];
  /** Benchmark distance (km) placed in week 1, when this is an assessment week. */
  assessment: { benchmarkKm: number | null } | null;
  /** The brief a coach reads to write (or rewrite) the blueprint. */
  brief: string;
};

export function planWindow(today: string, raceDate: string | null, startDate?: string | null) {
  const planStart = startDate && startDate >= today ? mondayOfWeekYMD(startDate) : nextMondayOnOrAfterYMD(today);
  const raceSlot = raceDate ? raceSlotYMD(planStart, raceDate) : null;
  let weeksToRace: number | null = null;
  let totalWeeks: number;
  if (raceSlot) {
    weeksToRace = Math.max(1, raceSlot.week);
    totalWeeks = Math.min(weeksToRace, 52);
  } else {
    // No race, or a race on or before the plan start: a general 12-week plan.
    totalWeeks = 12;
  }
  return { planStart, weeksToRace, totalWeeks, raceInWindow: raceSlot != null };
}

export function buildPlan(input: BuildPlanInput): BuildPlanResult {
  const { profile, goal, today } = input;
  const { planStart, weeksToRace, totalWeeks, raceInWindow } = planWindow(today, goal?.raceDate ?? null, input.startDate);
  const raceDate = raceInWindow ? goal?.raceDate ?? null : null;
  const goalType = goal?.type ?? "improve_fitness";

  const envelope = buildPlanEnvelope({
    profile,
    goal: goal ? { type: goal.type, sport: "run", raceDate, eventDistanceKm: goal.eventDistanceKm } : null,
    totalWeeks,
    weeksToRace,
    runOnly: true,
    selfReport: profile.prefs.sport_volume ?? null,
  });

  let blueprint: Blueprint | null = null;
  const supplied = input.blueprint != null;
  if (supplied) {
    const raw = typeof input.blueprint === "string" ? input.blueprint : JSON.stringify(input.blueprint);
    blueprint = parseBlueprint(raw, envelope);
  }
  if (!blueprint) blueprint = defaultBlueprint(envelope, profile, goalType);

  const plan = expandPlan({ envelope, blueprint, profile, prefs: profile.prefs, goalType, hasRace: !!raceDate });
  stripNonRunSessions(plan.weeks);

  if (envelope.roles.run !== "off" && profile.run.paceAnchor?.source === "easy_ratio") {
    plan.plan_notes = [plan.plan_notes, ESTIMATED_PACES_NOTE].filter(Boolean).join(" ");
  }

  // Invariants: critical violations are repaired in the safe direction (ease
  // load, never add it). Whatever remains is reported, never hidden.
  const isMastersOrBeginner = (profile.ageYears ?? 0) >= 50 || profile.experienceLevel === "beginner";
  const checkCtx = { envelope, plan, profile, totalWeeks, hasRace: !!raceDate, isMastersOrBeginner };
  let violations = checkPlan(checkCtx);
  let repaired: string[] = [];
  const critical = violations.filter((x) => x.severity === "critical");
  if (critical.length) {
    repaired = repairPlan(plan, critical).repaired;
    if (repaired.length) violations = checkPlan(checkCtx);
  }
  const structuralProblems = validatePlan(plan, totalWeeks);

  // Coach guidance on every quality and long session, for the whole block.
  const stored = toStoredBlueprint(blueprint, 0);
  for (const week of plan.weeks) {
    for (const s of week.workouts) {
      s.coach_cue = sessionGuidance(stored, { week_number: week.week_number, sport: s.sport ?? "run", workout_type: s.workout_type, title: s.title });
    }
  }

  // Warm-up, main set and cool-down with paces for every quality session.
  const raceKm = goal ? raceKmFor(goal.type, goal.eventDistanceKm) : undefined;
  const racePace = goal?.targetTimeSecs && raceKm ? goal.targetTimeSecs / raceKm : null;
  structurePlan(plan, envelope, profile, { racePaceSecPerKm: racePace, goalType });

  let assessment: BuildPlanResult["assessment"] = null;
  if (input.assessment) {
    const placed = applyAssessmentWeek(plan, envelope, profile);
    assessment = { benchmarkKm: placed.run ?? null };
  }

  pinRaceSession(plan, planStart, raceDate, goal?.type ?? null, "run", {
    distanceKm: goal?.type === "ultra" ? goal.eventDistanceKm : null,
    durationMin: null,
  });

  // The web app checked before pinning, so race week always read as empty.
  // Re-check the finished plan so the coach sees only real findings.
  const finalViolations = checkPlan(checkCtx);

  return {
    planStart, totalWeeks, weeksToRace, envelope, blueprint, finalViolations,
    blueprintSource: blueprint.source,
    blueprintRejected: supplied && blueprint.source === "fallback",
    plan,
    sessions: datedSessions(plan, planStart, today),
    violations, repaired, structuralProblems, assessment,
    brief: blueprintBrief(envelope, profile, { planStart, totalWeeks, today, raceDate, goalType, constraint: input.constraint }),
  };
}

/** Calendar dates for every session, skipping days already past (the web app's buildWorkoutRows). */
export function datedSessions(plan: GeneratedPlan, planStart: string, today: string): DatedSession[] {
  const out: DatedSession[] = [];
  for (const week of plan.weeks) {
    for (const s of week.workouts) {
      const date = addDaysYMD(planStart, (week.week_number - 1) * 7 + (s.day_of_week - 1));
      if (date < today) continue;
      out.push({
        date,
        week_number: week.week_number,
        day_of_week: s.day_of_week,
        title: s.title?.trim() || neutralTitle(s.workout_type, s.sport ?? null),
        workout_type: s.workout_type,
        target_distance_km: s.target_distance_km,
        target_duration_min: s.target_duration_min ?? null,
        target_pace_zone: s.target_pace_zone,
        description: s.description ?? null,
        coach_cue: s.coach_cue ?? null,
        segments: s.segments?.length ? s.segments : null,
        pinned: s.workout_type === "race",
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
