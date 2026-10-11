/**
 * Race-day pinning and neutral session titles. Ported verbatim from the Vēlox
 * web app's lib/coach-llm.ts (the LLM code in that file is not ported).
 */
import type { GeneratedPlan, GeneratedSession } from "../types/calendar";
import { raceSlotYMD } from "../dates";

/** The web app's local race-distance table for pinning (it differs from the
 *  predictor's: it knows 15k and 10 mile, and has no ultra entry). */
const RACE_KM: Record<string, number> = { "5k": 5, "10k": 10, "15k": 15, "10_mile": 16.1, half_marathon: 21.1, marathon: 42.2 };

export function neutralTitle(workoutType: string, sport?: string | null): string {
  // Non-run disciplines title by sport; the workout type stays the intent.
  if (sport === "bike") {
    switch (workoutType) {
      case "race":     return "Bike race";
      case "recovery": return "Recovery ride";
      case "tempo": case "threshold": case "interval": return "Bike intervals";
      default:         return "Bike ride";
    }
  }
  if (sport === "swim") {
    switch (workoutType) {
      case "race":     return "Swim race";
      case "recovery": return "Recovery swim";
      case "tempo": case "threshold": case "interval": return "Swim intervals";
      default:         return "Swim";
    }
  }
  if (sport === "strength") return "Strength";
  switch (workoutType) {
    case "easy": return "Easy run";
    case "long_run": return "Long run";
    case "tempo": return "Tempo run";
    case "threshold": return "Threshold run";
    case "interval": return "Intervals";
    case "recovery": return "Recovery run";
    case "race": return "Race";
    case "cross_train": return "Cross-training";
    case "rest": return "Rest day";
    default: return "Run";
  }
}

/** Deterministically pin the goal race on its exact date (week+day from plan start), removing
 *  any race the model placed on a wrong date and trimming sessions after race day. The model's
 *  week math is not trusted for the one thing that must be exact: race day. */
export function pinRaceSession(
  plan: GeneratedPlan,
  planStart: string,
  raceDate: string | null,
  goalType: string | null,
  raceSport?: string | null,
  event?: { distanceKm?: number | null; durationMin?: number | null },
): GeneratedPlan {
  if (!raceDate) return plan;
  const slot = raceSlotYMD(planStart, raceDate);
  if (!slot) return plan;
  // Running races pin at their exact distance; bike/swim/triathlon events have
  // no single running distance, so the race session carries the sport plus
  // whatever the event's own numbers are (a bike event's distance and estimated
  // duration, a swim event's distance). A session with no measure at all used to
  // be skipped by the describe pass, leaving race day as the one session in the
  // plan with no coaching note.
  const sport = (raceSport === "bike" || raceSport === "swim" || raceSport === "triathlon") ? raceSport : "run";
  // The athlete's own distance first, for run goal types that do not imply one:
  // this local table has no `ultra` key, so every ultra race day used to pin as
  // a 21.1 km session off the fallback below.
  const raceKm = sport === "run"
    ? (event?.distanceKm ?? ((goalType && RACE_KM[goalType]) || 21.1))
    : (event?.distanceKm ?? null);
  const raceMin = sport === "run" ? null : (event?.durationMin ?? null);

  // Drop every A-race duplicate the model emitted on other days of race week,
  // and any week past the race week. B-event race sessions on other weeks stay.
  plan.weeks = plan.weeks.filter(w => w.week_number <= slot.week);
  const raceWeek = plan.weeks.find(w => w.week_number === slot.week);
  if (raceWeek) raceWeek.workouts = raceWeek.workouts.filter(s => s.workout_type !== "race");

  // Ensure the race week exists.
  let wk = plan.weeks.find(w => w.week_number === slot.week);
  if (!wk) { wk = { week_number: slot.week, phase: "taper", target_weekly_km: (raceKm ?? 0) + 6, workouts: [] }; plan.weeks.push(wk); plan.weeks.sort((a, b) => a.week_number - b.week_number); }

  // Clear the race day, then pin the race there.
  wk.workouts = wk.workouts.filter(s => s.day_of_week !== slot.day);
  const race: GeneratedSession = {
    day_of_week: slot.day, title: "Race", workout_type: "race",
    sport: sport === "triathlon" ? "run" : sport, // planned_workouts sport enum has no triathlon; race day of a tri is tagged run
    description: "Race day. Trust the work you have put in and run your plan.",
    target_distance_km: raceKm,
    target_duration_min: raceMin,
    target_pace_zone: "race_pace",
  };
  wk.workouts.push(race);

  // The race lands on its real calendar date, which the schedule solver could not
  // know when it placed the rest of taper week: a quality session it put the day
  // before or after can end up adjacent to the race itself. Ease those (never
  // remove them, since the athlete may want a short shakeout either side), in
  // EVERY week that borders race week too, since a race in week 1 of its week
  // can neighbour the last day of the PREVIOUS week.
  const prevDay = slot.day === 1 ? 7 : slot.day - 1;
  const nextDay = slot.day === 7 ? 1 : slot.day + 1;
  const prevWeekNum = slot.day === 1 ? slot.week - 1 : slot.week;
  const nextWeekNum = slot.day === 7 ? slot.week + 1 : slot.week;
  const easeIfHard = (weekNum: number, day: number) => {
    const w = plan.weeks.find(x => x.week_number === weekNum);
    const s = w?.workouts.find(x => x.day_of_week === day && x.workout_type !== "race" && x.workout_type !== "rest");
    if (!s) return;
    const HARD = new Set(["tempo", "threshold", "interval", "long_run"]);
    if (HARD.has(s.workout_type)) {
      s.workout_type = s.workout_type === "long_run" ? "easy" : "recovery";
      s.title = neutralTitle(s.workout_type, s.sport ?? null);
    }
  };
  easeIfHard(prevWeekNum, prevDay);
  easeIfHard(nextWeekNum, nextDay);
  return plan;
}
