/**
 * The cycling side of a plan: weekly riding hours and the long-ride arc.
 *
 * Cycling periodises on TIME, not distance. An hour on a flat road and an hour in
 * the mountains are the same training stress and wildly different distances, so
 * every target here is hours, with distance left to the day itself.
 *
 * Science encoded:
 *  - Anchor week 1 to the athlete's own recent riding time, never to a template.
 *  - Ramp weekly hours ~8%/week. Cycling carries almost no impact load, so riders
 *    tolerate more volume than runners, but the cardiovascular and glycogen cost
 *    still needs progressive overload rather than a jump.
 *  - The long ride is the backbone, exactly as the long run is for a runner. It
 *    climbs toward ~70% of the event's expected duration, which is the point at
 *    which race day stops being a shock, and it SHRINKS through the taper.
 *  - Quality progresses by phase: sweet spot (88-94% FTP) in base, threshold
 *    (95-105%) in build, VO2 (106-120%) in peak, with race-specific work rising.
 *    Two quality rides a week is the ceiling for most riders, three only for
 *    advanced athletes with the hours to absorb them.
 */

import type { BikeWeek, Phase, SportRole } from "./types";
import { bikeWeekTss } from "./types";
import { startFromSelfReport } from "./self-report";

/** Weekly hours ramp. Gentler than running's 10% because the absolute hours are
 *  larger, so the same percentage is a much bigger jump in real time. */
const RAMP = 1.08;
const RAMP_CONSERVATIVE = 1.06;
/** Share of the week the long ride may take. Above this the week becomes one ride
 *  and some scraps, which trains durability at the cost of everything else. */
const LONG_RIDE_SHARE = 0.45;
/** Absolute ceiling on a single prescribed ride. Beyond six hours the returns are
 *  mostly mental, and the recovery cost stops being worth it outside ultra-distance. */
const LONG_RIDE_CAP_H = 6;
/**
 * How much of the event's duration the longest training ride should reach.
 *
 * Duration-dependent, because "70% of the event" means very different things at
 * different distances. A two-hour event can and should be ridden through in
 * training; nobody rides a full six-hour Ironman bike leg in preparation, but
 * stopping at 70% (four hours) leaves too much of race day untrained, and most
 * long-course plans peak nearer 80-85% of the split.
 */
function longRideFractionFor(eventHours: number): number {
  if (eventHours <= 2) return 1.0;
  if (eventHours <= 4) return 0.85;
  if (eventHours <= 6) return 0.8;
  return 0.75;
}
/** The long ride starts at this share of its eventual target and climbs to it
 *  across the build, so it is an arc rather than a step. */
const LONG_RIDE_START_SHARE = 0.6;
/** Starting weekly hours when there is no riding history at all, by experience. */
const START_HOURS: Record<string, number> = { beginner: 2.5, intermediate: 4.5, advanced: 6.5 };
/** Ceiling on weekly hours by experience, before the athlete's own time budget applies. */
const PEAK_HOURS_CAP: Record<string, number> = { beginner: 8, intermediate: 12, advanced: 18 };

export type BikeEnvelopeInput = {
  role: SportRole;
  experience: "beginner" | "intermediate" | "advanced";
  /** Mean weekly riding hours over the last 4 complete weeks. */
  recentHours: number;
  /** Longest single ride in the last 6 weeks (hours). */
  recentLongRideHours: number;
  /** Estimated event duration in hours, when the goal is a bike or triathlon event. */
  eventHours: number | null;
  /** Sessions per week the athlete has time for in this sport. */
  sessions: number;
  phases: { phase: Phase; isRecovery: boolean; taperMultiplier: number | null }[];
  isMasters: boolean;
  injuryActive: boolean;
  /** Fraction applied to week 1 when the athlete arrives under-recovered. */
  openingDamp: number;
  /** Sign-up weekly hours, passed only when riding history is thin and cycling
   *  is a primary sport, under SELF_REPORT_START (#121, C1). */
  selfReportedHours?: number | null;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

export function buildBikeEnvelope(input: BikeEnvelopeInput): (BikeWeek | null)[] {
  if (input.role === "off") return input.phases.map(() => null);

  const support = input.role === "support";
  // A support sport holds fitness rather than building it. Anchor to what the
  // athlete already does, and cap it so cycling never crowds out the goal sport.
  const fromReport = support ? null
    : startFromSelfReport(input.selfReportedHours, START_HOURS[input.experience] ?? 4.5, PEAK_HOURS_CAP[input.experience] ?? 12);
  const anchor = fromReport != null
    ? fromReport
    : input.recentHours > 0
      ? input.recentHours
      : (START_HOURS[input.experience] ?? 4.5) * (support ? 0.4 : 1);
  const start = Math.max(support ? 0.75 : 1.5, r1(anchor * input.openingDamp));

  const peakCap = support
    ? Math.max(start, anchor * 1.15)
    : Math.min(
        PEAK_HOURS_CAP[input.experience] ?? 12,
        Math.max(start * 1.8, start + 3),
      );

  // Long-ride target: 70% of the event, capped. Without an event (a support sport
  // or a general block) the long ride simply tracks the week.
  const longRideGoal = input.eventHours != null && input.eventHours > 0
    ? Math.min(LONG_RIDE_CAP_H, r1(input.eventHours * longRideFractionFor(input.eventHours)))
    : null;

  const ramp = input.injuryActive || input.isMasters ? RAMP_CONSERVATIVE : RAMP;
  const buildCount = Math.max(1, input.phases.filter((p) => p.taperMultiplier == null).length);

  const out: (BikeWeek | null)[] = [];
  let working = start;      // the rolling working volume, unaffected by deloads
  let longRidePeak = 0;
  let prevRecovery = false;

  for (let i = 0; i < input.phases.length; i++) {
    const { isRecovery, taperMultiplier } = input.phases[i];
    let hours: number;

    if (taperMultiplier != null) {
      hours = working * taperMultiplier;
    } else if (i === 0) {
      hours = start;
    } else if (isRecovery) {
      // A down week, not a stop: the aerobic engine is maintained on ~75% of the
      // working volume while the fatigue clears.
      hours = working * 0.75;
    } else if (prevRecovery) {
      hours = working; // return to the established volume, no ramp on top
    } else {
      hours = Math.min(working * ramp, peakCap);
      working = hours;
    }
    prevRecovery = isRecovery;

    // The long ride climbs with the week and honours what the athlete already
    // rides, but never exceeds the event-readiness target or the absolute cap.
    let longRide: number;
    if (taperMultiplier != null) {
      // Taper: shrink from the peak long ride. Never introduce the biggest ride of
      // the block in the week meant to shed fatigue.
      longRide = r1(Math.min(longRidePeak * taperMultiplier, longRidePeak || hours * LONG_RIDE_SHARE));
    } else {
      // The long ride is an ARC, not a step. Starting it at its eventual target in
      // week 1 wastes the whole block: an athlete who can already ride four hours
      // needs to be riding five by the peak, not four for twenty weeks. It climbs
      // linearly across the build toward the event-readiness target.
      const progress = buildCount > 1 ? Math.min(1, i / (buildCount - 1)) : 1;
      const arcTarget = longRideGoal != null
        ? longRideGoal * (LONG_RIDE_START_SHARE + (1 - LONG_RIDE_START_SHARE) * progress)
        : LONG_RIDE_CAP_H;
      const fromWeek = hours * LONG_RIDE_SHARE;
      const fromHistory = !isRecovery && input.recentLongRideHours > 0
        ? Math.min(input.recentLongRideHours, hours * 0.6)
        : 0;
      longRide = r1(Math.min(
        Math.max(fromWeek, fromHistory),
        // Recovery weeks cut the long ride like every other session.
        isRecovery ? arcTarget * 0.75 : arcTarget,
        LONG_RIDE_CAP_H,
        hours, // a long ride can never exceed the whole week
      ));
      if (!isRecovery) longRidePeak = Math.max(longRidePeak, longRide);
    }

    const h = r1(Math.max(0.5, hours));
    out.push({
      hours: h,
      longRideHours: Math.max(0, Math.min(longRide, h)),
      sessions: input.sessions,
      tss: bikeWeekTss(h),
    });
  }

  return out;
}

/** Can the plan build the long ride far enough for the event? */
export function bikeVerdict(weeks: (BikeWeek | null)[], eventHours: number | null, recentLongRideHours: number): { adequate: boolean; note: string | null } {
  if (eventHours == null || eventHours <= 0) return { adequate: true, note: null };
  const goal = Math.min(LONG_RIDE_CAP_H, r1(eventHours * longRideFractionFor(eventHours)));
  // Exclude the race week: the event itself is not preparation for the event.
  const build = weeks.slice(0, -1).filter((w): w is BikeWeek => w != null);
  const peak = Math.max(...build.map((w) => w.longRideHours), recentLongRideHours || 0, 0);
  if (peak + 0.05 >= goal) return { adequate: true, note: null };
  return {
    adequate: false,
    note: `The long ride only builds to about ${r1(peak)} h, but an event of roughly ${r1(eventHours)} h wants a longest ride near ${goal} h. Race day will be longer than anything trained for, so pace it conservatively and plan the nutrition carefully. More weeks, or more riding time each week, would prepare it properly.`,
  };
}

/**
 * Power-anchored quality prescription for a phase. Returned as guidance for the
 * coaching layer rather than as fixed sessions, because which of these a given
 * athlete needs depends on their event and their history.
 */
export function bikeQualityForPhase(phase: Phase, ftp: number | null): string {
  const pct = (lo: number, hi: number) => ftp != null ? ` (${Math.round(ftp * lo)}-${Math.round(ftp * hi)} W)` : "";
  switch (phase) {
    case "base":     return `sweet spot 88-94% FTP${pct(0.88, 0.94)}, long endurance rides, cadence work`;
    case "build":    return `threshold 95-105% FTP${pct(0.95, 1.05)}, sweet-spot volume, race-pace blocks in the long ride`;
    case "peak":     return `VO2 106-120% FTP${pct(1.06, 1.20)} in short reps, race-specific efforts, one long ride with race-intensity blocks`;
    case "taper":    return `short race-pace openers, everything else easy`;
    case "recovery": return `easy spinning only, no quality`;
  }
}
