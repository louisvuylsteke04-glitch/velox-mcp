/**
 * Expansion: envelope + blueprint -> a full, day-by-day GeneratedPlan.
 *
 * Every week is produced here, deterministically, from numbers the engine already
 * settled and a shape the coach chose. That is what makes truncation structurally
 * impossible: there is no point at which a model is asked to emit week 17 of 20
 * and stops. A 40-week plan costs the same single small LLM call as a 6-week one.
 *
 * The blueprint's template is honoured where it is safe and repaired where it is
 * not, because a coach writing a weekly shape in prose will occasionally put two
 * hard days together or forget that week 12 is a deload.
 */

import type { GeneratedPlan, GeneratedSession, GeneratedWeek, PaceZone, WorkoutType } from "../types/calendar";
import type { AthleteProfile } from "./profile";
import type { EnvelopeWeek, PlanEnvelope, SportKey } from "./types";
import { type Blueprint, phaseForWeek } from "./blueprint";
import { scheduleWeek, type ScheduledSession } from "./schedule";
import type { TrainingPreferences } from "../training-preferences";

/** Pace/effort zone for a session, by what the session is for. */
function zoneFor(kind: ScheduledSession["kind"], phase: EnvelopeWeek["phase"]): PaceZone {
  switch (kind) {
    case "quality": return phase === "peak" ? "zone5" : phase === "build" ? "zone4" : "zone3";
    case "long":    return "zone2";
    case "recovery": return "zone1";
    case "brick_run": return "zone2";
    default:        return "zone2";
  }
}

/** planned_workouts.workout_type for a scheduled session. */
function workoutTypeFor(s: ScheduledSession, phase: EnvelopeWeek["phase"]): WorkoutType {
  if (s.sport !== "run") {
    // Bike and swim sessions carry the intent in workout_type too, so the calendar
    // and the load model can tell a hard ride from an easy one.
    if (s.kind === "quality") return phase === "peak" ? "interval" : "threshold";
    if (s.kind === "recovery") return "recovery";
    return "easy";
  }
  switch (s.kind) {
    case "long":      return "long_run";
    case "quality":   return phase === "peak" ? "interval" : phase === "build" ? "threshold" : "tempo";
    case "recovery":  return "recovery";
    case "brick_run": return "easy";
    default:          return "easy";
  }
}

export type ExpandInput = {
  envelope: PlanEnvelope;
  blueprint: Blueprint;
  profile: AthleteProfile;
  prefs: TrainingPreferences;
  goalType: string;
  /** True when the plan has an A race, so the final week is race week. */
  hasRace: boolean;
};

export function expandPlan(input: ExpandInput): GeneratedPlan {
  const { envelope, blueprint, profile, prefs, goalType } = input;
  const isTri = goalType.startsWith("triathlon");
  const isMastersOrBeginner = (profile.ageYears ?? 0) >= 50 || profile.experienceLevel === "beginner";

  const weeks: GeneratedWeek[] = envelope.weeks.map((envWeek) => {
    const applied = applyOverride(envWeek, blueprint);
    const phase = phaseForWeek(blueprint, applied.week_number);

    // The solver owns spacing and placement; the blueprint's template is passed in
    // as the preferred DAY for each sport, so the coach's shape is honoured without
    // letting it break a recovery rule.
    const preferredDays = new Map<SportKey, number[]>();
    for (const slot of phase?.template ?? []) {
      const list = preferredDays.get(slot.sport) ?? [];
      if (!list.includes(slot.day)) list.push(slot.day);
      preferredDays.set(slot.sport, list);
    }

    const sched = scheduleWeek(applied, prefs, {
      isTri,
      isMastersOrBeginner,
      variationSeed: applied.week_number,
      sportDays: preferredDays,
    });

    // Race week belongs to the race. pinRaceSession places the event itself on its
    // exact date afterwards, so scheduling the week's long session as well would
    // put a 21 km run on the Saturday before a half-Ironman.
    const isRaceWeek = input.hasRace && applied.week_number === envelope.weeks.length;
    const placed = isRaceWeek ? sched.sessions.filter((s) => s.kind !== "long") : sched.sessions;

    const workouts: GeneratedSession[] = placed.map((s) => {
      const wtype = workoutTypeFor(s, applied.phase);
      return {
        day_of_week: s.day,
        // The long ride and long swim are the key sessions of their week, and the
        // workout_type enum has no word for them (only "long_run"), so the title
        // carries it. buildWorkoutRows keeps a title the engine set.
        title: s.kind === "long" && s.sport !== "run"
          ? (s.sport === "bike" ? "Long ride" : "Long swim")
          : "",
        workout_type: wtype,
        sport: s.sport,
        target_distance_km: s.distanceKm != null ? round1(s.distanceKm) : null,
        target_duration_min: s.durationMin,
        target_pace_zone: zoneFor(s.kind, applied.phase),
      };
    });

    return {
      week_number: applied.week_number,
      phase: applied.isRecovery ? "recovery" : applied.phase,
      // Weekly running volume stays the meaning of target_weekly_km, for every
      // existing reader of week_targets.
      target_weekly_km: applied.run?.km ?? 0,
      workouts,
    };
  });

  return { plan_notes: blueprint.plan_notes, weeks };
}

/**
 * Apply a week-level exception from the blueprint.
 *
 * The coach may know something the load model cannot: an athlete who always needs
 * an extra down week, a week where life will get in the way. These are bounded
 * adjustments to an existing week, never a licence to rewrite the envelope.
 */
function applyOverride(week: EnvelopeWeek, bp: Blueprint): EnvelopeWeek {
  const ov = bp.week_overrides.find((o) => o.week === week.week_number);
  if (!ov) return week;
  const w: EnvelopeWeek = {
    ...week,
    run: week.run ? { ...week.run } : null,
    bike: week.bike ? { ...week.bike } : null,
    swim: week.swim ? { ...week.swim } : null,
  };
  const scale = (f: number) => {
    if (w.run) { w.run.km = round1(w.run.km * f); w.run.longRunKm = round1(Math.min(w.run.longRunKm, w.run.km * 0.5)); w.run.tss = Math.round(w.run.tss * f); }
    if (w.bike) { w.bike.hours = round1(w.bike.hours * f); w.bike.longRideHours = round1(Math.min(w.bike.longRideHours, w.bike.hours)); w.bike.tss = Math.round(w.bike.tss * f); }
    if (w.swim) {
      if (w.swim.metres != null) w.swim.metres = Math.round(w.swim.metres * f);
      w.swim.minutes = Math.round(w.swim.minutes * f);
      w.swim.tss = Math.round(w.swim.tss * f);
    }
    w.tssTotal = (w.run?.tss ?? 0) + (w.bike?.tss ?? 0) + (w.swim?.tss ?? 0);
    w.hours = round1(w.hours * f);
  };
  switch (ov.change) {
    case "extra_deload":   w.isRecovery = true; scale(0.75); break;
    case "hold_volume":    break; // no change to volume; the note explains why
    case "ease_intensity": w.brick = false; break;
    case "sharpen":        break; // intensity is the describe pass's business
  }
  return w;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Structural invariants that must hold for any stored plan, checked after
 * expansion. These are the rules the whole engine exists to guarantee, so they are
 * asserted rather than assumed: a bug that reintroduces two hard days in a row
 * should fail loudly here, not quietly reach an athlete.
 */
export function validatePlan(plan: GeneratedPlan, totalWeeks: number): string[] {
  const problems: string[] = [];
  const byWeek = new Map(plan.weeks.map((w) => [w.week_number, w]));
  for (let i = 1; i <= totalWeeks; i++) {
    const w = byWeek.get(i);
    if (!w) { problems.push(`week ${i} missing`); continue; }
    if (!w.workouts.length) problems.push(`week ${i} has no sessions`);

    const byDay = new Map<number, GeneratedSession[]>();
    for (const s of w.workouts) byDay.set(s.day_of_week, [...(byDay.get(s.day_of_week) ?? []), s]);

    for (const [day, list] of byDay) {
      if (list.length > 2) problems.push(`week ${i} day ${day} has ${list.length} sessions`);
      if (new Set(list.map((s) => s.sport ?? "run")).size !== list.length) {
        problems.push(`week ${i} day ${day} has two sessions of the same sport`);
      }
      if (list.filter(isHard).length > 1) problems.push(`week ${i} day ${day} has two hard sessions`);
    }
    for (let d = 1; d < 7; d++) {
      if ((byDay.get(d) ?? []).some(isHard) && (byDay.get(d + 1) ?? []).some(isHard)) {
        problems.push(`week ${i} has hard sessions on consecutive days ${d} and ${d + 1}`);
      }
    }
    for (const s of w.workouts) {
      if (s.target_distance_km != null && (!Number.isFinite(s.target_distance_km) || s.target_distance_km <= 0)) {
        problems.push(`week ${i} has a session with distance ${s.target_distance_km}`);
      }
      if (s.target_duration_min != null && (!Number.isFinite(s.target_duration_min) || s.target_duration_min <= 0)) {
        problems.push(`week ${i} has a session with duration ${s.target_duration_min}`);
      }
    }
  }
  return problems;
}

const HARD_TYPES = new Set<WorkoutType>(["tempo", "threshold", "interval", "race", "long_run"]);
function isHard(s: GeneratedSession): boolean {
  return HARD_TYPES.has(s.workout_type);
}
