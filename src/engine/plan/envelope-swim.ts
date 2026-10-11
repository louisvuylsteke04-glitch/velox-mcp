/**
 * The swimming side of a plan: weekly volume, frequency, and the longest swim.
 *
 * Swimming is the one endurance sport where technique dominates fitness. A weak
 * swimmer gets far more from four short swims a week than from two long ones,
 * because every session is another chance to move better through the water. So
 * this envelope is FREQUENCY-FIRST: it fills sessions before it lengthens them,
 * and only grows the individual swim once the athlete is swimming often enough.
 *
 * Science encoded:
 *  - 2 sessions a week is the floor for maintaining feel for the water; 3-4 is
 *    where technique actually improves.
 *  - Weekly volume ramps ~10%/week, off the athlete's own recent volume.
 *  - For an open-water or triathlon race, the longest continuous swim should reach
 *    about 1.2x the race distance, so the distance itself is never the unknown.
 *  - Sessions are prescribed in METRES when the athlete's watch records distance,
 *    and in MINUTES when it does not. Some athletes' swims log time only, and a
 *    metre target they cannot measure is worse than useless.
 */

import type { Phase, SportRole, SwimWeek } from "./types";
import { swimMinutes, swimWeekTss } from "./types";
import { startFromSelfReport } from "./self-report";

const RAMP = 1.10;
const RAMP_CONSERVATIVE = 1.07;
/** Weekly volume ceilings (metres) by event. Beyond these, more swimming stops
 *  paying for the time it costs an age-group triathlete. */
const WEEK_CAP_M: Record<string, number> = {
  triathlon_sprint: 4000,
  triathlon_olympic: 6000,
  triathlon_half: 8000,
  triathlon_full: 11000,
  swim_event: 14000,
};
const DEFAULT_WEEK_CAP_M = 6000;
/** The longest swim should reach this multiple of race distance. */
const LONGEST_SWIM_RACE_MULTIPLE = 1.2;
/** Starting weekly metres with no swim history, by experience. */
const START_M: Record<string, number> = { beginner: 1500, intermediate: 2500, advanced: 3500 };

export type SwimEnvelopeInput = {
  role: SportRole;
  experience: "beginner" | "intermediate" | "advanced";
  /** Mean weekly metres over the last 4 complete weeks (0 if none or not recorded). */
  recentMetres: number;
  /** Mean weekly swim hours, the fallback anchor when distance is not recorded. */
  recentHours: number;
  /** True when the athlete's swims record distance at all. */
  distanceRecorded: boolean;
  /** Race swim distance in metres (triathlon leg or swim event), when there is one. */
  raceDistanceM: number | null;
  /** Goal type, for the weekly volume ceiling. */
  goalType: string;
  /** The athlete's swim threshold pace, for converting metres to session time. */
  cssSecPer100m: number | null;
  sessions: number;
  phases: { phase: Phase; isRecovery: boolean; taperMultiplier: number | null }[];
  isMasters: boolean;
  openingDamp: number;
  /** Sign-up weekly metres (sessions x typical session), passed only when swim
   *  history is thin and swimming is a primary sport, under SELF_REPORT_START. */
  selfReportedMetres?: number | null;
};

export function buildSwimEnvelope(input: SwimEnvelopeInput): (SwimWeek | null)[] {
  if (input.role === "off") return input.phases.map(() => null);

  const support = input.role === "support";
  const cap = (WEEK_CAP_M[input.goalType] ?? DEFAULT_WEEK_CAP_M) * (support ? 0.5 : 1);

  // Anchor. When the athlete's swims carry no distance we convert their recorded
  // TIME into metres at their own pace, so the plan still has one internal unit.
  // Hours -> SECONDS -> metres at the athlete's own pace. Using minutes here made
  // the anchor sixty times too small, so every athlete whose swims record time but
  // no distance was read as swimming a couple of hundred metres a week and got a
  // plan to match.
  const anchorFromTime = input.recentHours > 0
    ? (input.recentHours * 3600 * 100) / ((input.cssSecPer100m ?? 130) * 1.15)
    : 0;
  const fromReport = support ? null
    : startFromSelfReport(input.selfReportedMetres, START_M[input.experience] ?? 2500, cap);
  const anchor = fromReport != null
    ? fromReport
    : input.recentMetres > 0
    ? input.recentMetres
    : anchorFromTime > 0
      ? anchorFromTime
      : (START_M[input.experience] ?? 2500) * (support ? 0.5 : 1);

  // A race-demand floor. Ramping 10% a week from a near-zero anchor is right for
  // an athlete with no goal and wrong for one with a race: someone swimming twelve
  // minutes a week twelve weeks out from a 1.9 km swim leg does not need a gentle
  // progression, they need to start swimming. The floor is what the race itself
  // demands, not what would be ideal, and the honest verdict still fires if the
  // runway is too short to reach the longest swim.
  const raceFloorWeekly = input.role === "primary" && input.raceDistanceM != null && input.raceDistanceM > 0
    ? input.raceDistanceM * 1.5
    : 0;
  const start = Math.max(600, raceFloorWeekly * 0.7, Math.round(anchor * input.openingDamp));
  const ramp = input.isMasters ? RAMP_CONSERVATIVE : RAMP;

  // Longest continuous swim target: comfortably beyond race distance so the
  // distance itself is never the unknown on race day.
  const longestGoal = input.raceDistanceM != null && input.raceDistanceM > 0
    ? Math.round(input.raceDistanceM * LONGEST_SWIM_RACE_MULTIPLE)
    : null;

  const out: (SwimWeek | null)[] = [];
  let working = start;
  let prevRecovery = false;
  const buildWeeks = input.phases.filter((p) => p.taperMultiplier == null).length;

  for (let i = 0; i < input.phases.length; i++) {
    const { isRecovery, taperMultiplier } = input.phases[i];
    let metres: number;

    if (taperMultiplier != null) {
      // Swimming tapers least of the three sports: it is the least fatiguing and
      // the most feel-dependent, so frequency is held and only volume comes down.
      metres = working * Math.min(1, taperMultiplier + 0.15);
    } else if (i === 0) {
      metres = start;
    } else if (isRecovery) {
      metres = working * 0.8;
    } else if (prevRecovery) {
      metres = working;
    } else {
      metres = Math.min(working * ramp, cap);
      working = metres;
    }
    prevRecovery = isRecovery;

    // The longest swim climbs linearly across the build toward the race target,
    // and is never more than half the week's volume.
    const progress = buildWeeks > 1 ? Math.min(1, i / Math.max(1, buildWeeks - 1)) : 1;
    const longest = longestGoal != null
      ? Math.round(Math.min(longestGoal * (0.55 + 0.45 * progress), metres * 0.6))
      : null;

    const m = Math.round(Math.max(400, metres));
    const mins = swimMinutes(m, input.cssSecPer100m);
    out.push({
      // A metre target is only issued to athletes who can measure metres.
      metres: input.distanceRecorded ? m : null,
      minutes: mins,
      longestM: input.distanceRecorded ? longest : null,
      sessions: input.sessions,
      tss: swimWeekTss(mins),
    });
  }

  return out;
}

/** Can the plan build the longest swim far enough for the race? */
export function swimVerdict(
  weeks: (SwimWeek | null)[],
  raceDistanceM: number | null,
  recentLongestM: number,
  distanceRecorded: boolean,
): { adequate: boolean; note: string | null } {
  if (raceDistanceM == null || raceDistanceM <= 0) return { adequate: true, note: null };
  if (!distanceRecorded) {
    return {
      adequate: true,
      note: `Your swims record time but not distance, so swim sessions are prescribed by time. Before race day, do at least one continuous swim of about ${raceDistanceM} m in a pool where you can count it.`,
    };
  }
  const build = weeks.slice(0, -1).filter((w): w is SwimWeek => w != null);
  const peak = Math.max(...build.map((w) => w.longestM ?? 0), recentLongestM || 0, 0);
  if (peak >= raceDistanceM) return { adequate: true, note: null };
  return {
    adequate: false,
    note: `The longest swim only builds to about ${Math.round(peak)} m against a ${raceDistanceM} m race. Swimming further than you have trained is the most common reason a first open-water race goes badly, so add continuous swims where the timeline allows and start the race steady.`,
  };
}

/** What the swim work is for in each phase. */
export function swimFocusForPhase(phase: Phase, weak: boolean): string {
  if (weak) {
    // A weak swimmer improves through technique long before they improve through
    // volume, whatever phase the rest of the plan is in.
    switch (phase) {
      case "base":     return "technique and drills, short repeats with generous rest, building comfort";
      case "build":    return "technique held, aerobic repeats (100-200 m) at steady effort, occasional longer swim";
      case "peak":     return "continuous race-distance swimming, open-water skills if the race needs them";
      case "taper":    return "short, sharp, frequent: feel for the water over volume";
      case "recovery": return "easy technique work only";
    }
  }
  switch (phase) {
    case "base":     return "aerobic base, stroke efficiency, longer steady sets";
    case "build":    return "CSS repeats (100-400 m) at threshold, pace control";
    case "peak":     return "race-pace sets, open-water specifics (sighting, wetsuit, mass start), one continuous race-distance swim";
    case "taper":    return "short race-pace touches, frequency held, volume down";
    case "recovery": return "easy aerobic swimming";
  }
}
