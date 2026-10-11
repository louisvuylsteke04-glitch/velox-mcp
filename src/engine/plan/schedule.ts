/**
 * The schedule solver: turn one week of the envelope into actual days.
 *
 * Given how much of each sport a week contains, this decides which day each
 * session lands on and how big it is. It is pure and deterministic, so the rules
 * that keep an athlete healthy are testable rather than left to a prompt to
 * remember.
 *
 * The rules, in priority order:
 *   1. Only the athlete's preferred training days are used.
 *   2. The long run goes on the athlete's chosen long day; the long ride goes on
 *      the other weekend day when there is one, and never adjacent to the long run.
 *   3. No two hard days in a row, in ANY sport. A threshold ride the day before a
 *      long run is exactly as bad as a threshold run would be.
 *   4. Nothing hard the day before or the day after the long session.
 *   5. At most two sessions a day, always in different sports, and never two hard
 *      ones. Doubles exist for triathlon bricks and for swim-plus-easy-run days.
 *   6. Bricks are a bike session and a short run on the SAME day, bike first.
 *   7. At least one full rest day, two for masters and beginners.
 *
 * Where a rule cannot be satisfied (a five-session week on three preferred days,
 * say), the solver eases sessions rather than dropping them, because an athlete
 * who asked for five sessions should get five.
 */

import type { EnvelopeWeek, SportKey } from "./types";
import type { TrainingPreferences } from "../training-preferences";

export type ScheduledSession = {
  /** ISO weekday, 1 = Monday. */
  day: number;
  sport: SportKey;
  /** Which slot on the day: 0 first, 1 second (a double). */
  slot: number;
  kind: "long" | "quality" | "easy" | "recovery" | "brick_run";
  /** Run and swim distances; bike and swim also carry duration. */
  distanceKm: number | null;
  durationMin: number | null;
  /** True when this session is one of the week's hard efforts. */
  hard: boolean;
};

export type WeekSchedule = {
  week_number: number;
  sessions: ScheduledSession[];
  /** Rules that could not be honoured, for telemetry and honest plan notes. */
  compromises: string[];
};

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** How many quality sessions a week supports, by phase. Recovery weeks stay easy. */
function qualityBudget(week: EnvelopeWeek, isTri: boolean): number {
  if (week.isRecovery) return 0;
  if (week.phase === "taper") return 1;
  if (week.phase === "base") return isTri ? 2 : 1;
  // Build and peak: a single-sport plan gets 2 hard days, its real ceiling for
  // recovery between them. A triathlon needs a 3rd: with the ceiling held at 2,
  // qualityOrder's fixed [bike, run, swim] priority meant the third sport in that
  // list NEVER received quality, in ANY week, for the whole block — not a rare
  // miss but a permanent one. hardAllowed()/canAdd() still bound what actually
  // fits a given athlete's real days, so this is a target, not a guarantee.
  return isTri ? 3 : 2;
}

function rotate<T>(arr: T[], by: number): T[] {
  if (!arr.length) return arr;
  const n = ((by % arr.length) + arr.length) % arr.length;
  return [...arr.slice(n), ...arr.slice(0, n)];
}

/**
 * Lay out one week.
 *
 * `variationSeed` shifts which day the quality work starts from, so a 16-week plan
 * does not repeat one identical template sixteen times. It is derived from the
 * week number, so the result stays deterministic.
 */
export function scheduleWeek(
  week: EnvelopeWeek,
  prefs: TrainingPreferences,
  opts: {
    isTri: boolean;
    isMastersOrBeginner: boolean;
    variationSeed?: number;
    /**
     * The coach's preferred day(s) per sport, from the blueprint's weekly template.
     * Treated as a preference, not an instruction: a day is used only if it is one
     * of the athlete's training days and taking it would not break a spacing rule.
     * This is how the coaching layer shapes the week without being able to schedule
     * two hard days in a row.
     */
    sportDays?: Map<SportKey, number[]>;
  },
): WeekSchedule {
  const compromises: string[] = [];
  const preferred = prefs.preferred_days.length ? [...prefs.preferred_days].sort((a, b) => a - b) : ALL_DAYS;
  const longDay = preferred.includes(prefs.long_run_day) ? prefs.long_run_day : preferred[preferred.length - 1];

  // Occupancy: day -> sessions placed on it.
  const byDay = new Map<number, ScheduledSession[]>();
  const sessionsOn = (d: number) => byDay.get(d) ?? [];
  const hardOn = (d: number) => sessionsOn(d).some((s) => s.hard);
  const hasSport = (d: number, sport: SportKey) => sessionsOn(d).some((s) => s.sport === sport);
  const place = (s: ScheduledSession) => {
    const list = byDay.get(s.day) ?? [];
    s.slot = list.length;
    list.push(s);
    byDay.set(s.day, list);
  };
  /** A day can take a hard session only if neither neighbour is already hard. */
  const hardAllowed = (d: number) => !hardOn(d) && !hardOn(d === 1 ? 7 : d - 1) && !hardOn(d === 7 ? 1 : d + 1);
  const canAdd = (d: number, sport: SportKey) => sessionsOn(d).length < 2 && !hasSport(d, sport);

  const roles: SportKey[] = (["run", "bike", "swim"] as SportKey[]).filter((s) => week[s] != null);
  const budget = qualityBudget(week, opts.isTri);
  let qualityUsed = 0;

  // ── 1. The long sessions, which everything else works around ────────────────
  if (week.run && week.run.longRunKm > 0 && week.run.sessions > 0) {
    place({
      day: longDay, sport: "run", slot: 0, kind: "long",
      distanceKm: week.run.longRunKm, durationMin: null,
      // The long run is a hard day for spacing purposes even at easy pace: it is
      // the week's biggest single dose of impact.
      hard: true,
    });
  }

  if (week.bike && week.bike.longRideHours > 0 && week.bike.sessions > 0) {
    // The long ride wants its own day, at least 48 hours from the long run so
    // neither is run on the other's fatigue. Sorting toward the largest gap and
    // taking whatever came first only PREFERS distance, it doesn't require it: on
    // a short preferred-days list the "farthest" day can still be adjacent. Filter
    // for the real minimum first and only fall back to "farthest available" (and
    // record it as a compromise) when the athlete's days genuinely leave no room.
    const eligible = preferred.filter((d) => d !== longDay && canAdd(d, "bike"));
    const spaced = eligible.filter((d) => dayGap(d, longDay) >= 2);
    const day = (spaced.length ? spaced : eligible).sort((a, b) => dayGap(b, longDay) - dayGap(a, longDay))[0];
    if (day != null && !spaced.length && eligible.length) {
      compromises.push("the long ride could not be kept 48 hours from the long run given the athlete's available days");
    }
    if (day != null) {
      place({
        day, sport: "bike", slot: 0, kind: "long",
        distanceKm: null, durationMin: Math.round(week.bike.longRideHours * 60), hard: true,
      });
    } else {
      compromises.push("no separate day was free for the long ride");
    }
  }

  // ── 2. Quality, spread away from the long days ──────────────────────────────
  // Rotate the starting day per week so the block does not become one repeated
  // template, and prefer midweek so the weekend keeps the long sessions.
  const midweekBase = rotate(preferred.filter((d) => d !== longDay), opts.variationSeed ?? 0);
  /** The coach's days for a sport first, then everything else. */
  const daysFor = (sport: SportKey): number[] => {
    const wanted = (opts.sportDays?.get(sport) ?? []).filter((d) => preferred.includes(d) && d !== longDay);
    return [...wanted, ...midweekBase.filter((d) => !wanted.includes(d))];
  };
  const qualityOrder: SportKey[] = opts.isTri
    ? ["bike", "run", "swim"]     // the bike carries the most trainable time in a tri
    : [...roles].sort((a, b) => (week[a]?.sessions ?? 0) < (week[b]?.sessions ?? 0) ? 1 : -1);

  // Round-robin across sports, one quality session per sport per pass, until the
  // budget is spent or a full pass places nothing. A single shared counter that
  // breaks after N total placements starves whichever sport comes later in
  // qualityOrder: for a triathlon week with budget 2 and order [bike, run, swim],
  // bike and run would always win the two slots and swim would NEVER get quality,
  // in any week, for the whole plan. Breadth across sports before depth in any
  // one is what a real coach does with a limited number of hard days.
  const qualityPlacedThisSport = new Set<SportKey>();
  let progressedQuality = true;
  while (qualityUsed < budget && progressedQuality) {
    progressedQuality = false;
    for (const sport of qualityOrder) {
      if (qualityUsed >= budget) break;
      if (qualityPlacedThisSport.has(sport)) continue; // give every sport a turn first
      const w = week[sport];
      if (!w || w.sessions === 0) continue;
      const day = daysFor(sport).find((d) => hardAllowed(d) && canAdd(d, sport));
      if (day == null) continue;
      // Same floor as the easy-fill pass below: a quality run under the athlete's
      // minimum session distance is not a real quality session, it is noise.
      const qualityRunShare = sport === "run" ? sessionShare(week, "run", "quality") : null;
      if (sport === "run" && qualityRunShare != null && qualityRunShare < prefs.min_session_km) continue;
      place({
        day, sport, slot: 0, kind: "quality",
        distanceKm: sport === "run" ? qualityRunShare : sport === "swim" ? swimShareKm(week, sessionMinutes(week, sport, "quality")) : null,
        durationMin: sport === "run" ? null : sessionMinutes(week, sport, "quality"),
        hard: true,
      });
      qualityUsed++;
      qualityPlacedThisSport.add(sport);
      progressedQuality = true;
    }
    // Once every sport has had its first quality session, allow a second round
    // (a single-sport build week legitimately wants 2 quality sessions, not 1).
    if (!progressedQuality && qualityPlacedThisSport.size === qualityOrder.filter((s) => week[s]).length) {
      qualityPlacedThisSport.clear();
      progressedQuality = qualityUsed < budget;
    }
  }

  // ── 3. Bricks: a bike session with a short run straight off it ──────────────
  if (week.brick && week.bike && week.run) {
    // Put the brick on a day that already has the bike, or on a free preferred day.
    const bikeDay = [...byDay.entries()].find(([, list]) => list.some((s) => s.sport === "bike" && s.kind !== "long"))?.[0]
      ?? preferred.find((d) => d !== longDay && canAdd(d, "bike"));
    if (bikeDay != null) {
      if (!hasSport(bikeDay, "bike")) {
        place({
          day: bikeDay, sport: "bike", slot: 0, kind: "easy",
          distanceKm: null, durationMin: sessionMinutes(week, "bike", "easy"), hard: false,
        });
      }
      if (canAdd(bikeDay, "run")) {
        place({
          day: bikeDay, sport: "run", slot: 1, kind: "brick_run",
          // A brick run is short on purpose: it teaches the legs the transition,
          // it is not extra endurance work.
          distanceKm: null,
          durationMin: brickRunMinutes(week),
          hard: false,
        });
      } else {
        compromises.push("the brick run could not be placed with its ride");
      }
    }
  }

  // ── 4. Fill the remaining sessions with easy work ───────────────────────────
  const restDaysWanted = opts.isMastersOrBeginner ? 2 : 1;
  for (const sport of roles) {
    const w = week[sport];
    if (!w) continue;
    let placed = countSport(byDay, sport);
    let guard = 0;
    while (placed < w.sessions && guard++ < 20) {
      const restDays = ALL_DAYS.filter((d) => sessionsOn(d).length === 0).length;
      const day = daysFor(sport).find((d) => {
        if (!canAdd(d, sport)) return false;
        // Protect the rest days, and never stack a second session onto a hard day
        // unless it is deliberately easy and in another sport.
        if (sessionsOn(d).length === 0 && restDays <= restDaysWanted) return false;
        if (hardOn(d) && sport === "run") return false; // no easy run on a hard run's day
        return true;
      });
      if (day == null) break;
      // The athlete's own minimum session distance is a real floor, not a
      // suggestion (the coach's system prompt states it explicitly: "a shorter
      // run is a recovery run"). Splitting a low-volume week evenly across many
      // sessions can fall under it — confirmed on a real athlete restarting after
      // injury, whose week was divided into 400-600 m "runs". When a run session
      // would come out below the floor, stop adding MORE run sessions this week
      // rather than schedule one under it: fewer, real sessions beats more, fake
      // ones, and the long run already carries the bulk of the week's volume.
      const runShare = sport === "run" ? sessionShare(week, "run", "easy") : null;
      if (sport === "run" && runShare != null && runShare < prefs.min_session_km) {
        compromises.push(`stopped at ${placed} of ${w.sessions} run sessions: another would fall under the ${prefs.min_session_km} km minimum`);
        break;
      }
      place({
        // Filler sessions are EASY work, which is the bulk of any endurance plan.
        // "Recovery" is reserved for deload weeks, where the whole point is that
        // even the easy sessions are shorter and gentler than usual.
        day, sport, slot: 0, kind: week.isRecovery ? "recovery" : "easy",
        distanceKm: sport === "run" ? runShare : sport === "swim" ? swimShareKm(week, sessionMinutes(week, sport, "easy")) : null,
        durationMin: sport === "run" ? null : sessionMinutes(week, sport, "easy"),
        hard: false,
      });
      placed++;
    }
    if (placed < w.sessions) {
      compromises.push(`only ${placed} of ${w.sessions} ${sport} sessions fitted the available days`);
    }
  }

  const sessions = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, list]) => list.sort((a, b) => a.slot - b.slot));

  absorbIntoLongRide(week, sessions);
  enforceLongIsLongest(sessions, prefs.min_session_km);
  enforceLongestSwim(week, sessions);

  return { week_number: week.week_number, sessions, compromises };
}

/** Days between two weekdays, the short way around the week. */
function dayGap(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 7 - d);
}

function countSport(byDay: Map<number, ScheduledSession[]>, sport: SportKey): number {
  let n = 0;
  for (const list of byDay.values()) for (const s of list) if (s.sport === sport) n++;
  return n;
}

/**
 * How much of the week's running one session takes. The long run is already
 * allocated, so the rest is shared out with quality runs a little longer than
 * easy ones.
 */
function sessionShare(week: EnvelopeWeek, sport: "run", kind: "quality" | "easy"): number | null {
  const w = week[sport];
  if (!w) return null;
  const remaining = Math.max(0, w.km - w.longRunKm);
  const others = Math.max(1, w.sessions - 1);
  const base = remaining / others;
  return Math.round((kind === "quality" ? base * 1.15 : base) * 10) / 10;
}

/**
 * Session length in minutes for the non-running sports.
 *
 * Sharing the week's remaining hours equally between sessions is what produces
 * nonsense like a 220-minute "threshold" ride: a hard session has a length beyond
 * which it stops being that session and becomes an endurance ride with some
 * intervals in it. Quality is therefore capped at a realistic duration, and any
 * volume that does not fit belongs in the LONG ride, which is where long volume
 * is supposed to live.
 */
const BIKE_QUALITY_MAX_MIN = 120;   // a threshold or VO2 ride past two hours is an endurance ride
const BIKE_EASY_MAX_MIN = 180;      // a midweek easy ride is not a second long ride
const SWIM_SESSION_MAX_MIN = 90;
const SWIM_SESSION_MIN_MIN = 25;

/**
 * Distance for one swim session, proportional to its share of the week's total
 * swim time. Swimmers and triathletes read sessions in metres, and the DB stores
 * swim distance the same way every other sport's is stored (`target_distance_km`,
 * 2000 m = 2.0), so leaving it null made every swim read "45 min" with no
 * indication of the set. Null only for athletes whose own history carries no
 * distance at all (`week.swim.metres` is null in that case, by design).
 */
function swimShareKm(week: EnvelopeWeek, sessionMin: number | null): number | null {
  if (!week.swim?.metres || sessionMin == null || week.swim.minutes <= 0) return null;
  const metres = week.swim.metres * (sessionMin / week.swim.minutes);
  return Math.round(metres) / 1000;
}

function sessionMinutes(week: EnvelopeWeek, sport: SportKey, kind: "quality" | "easy"): number | null {
  if (sport === "bike" && week.bike) {
    const remaining = Math.max(0, week.bike.hours - week.bike.longRideHours) * 60;
    const others = Math.max(1, week.bike.sessions - 1);
    const base = remaining / others;
    const capped = Math.min(base * (kind === "quality" ? 1.1 : 1), kind === "quality" ? BIKE_QUALITY_MAX_MIN : BIKE_EASY_MAX_MIN);
    return Math.max(30, Math.round(capped / 5) * 5);
  }
  if (sport === "swim" && week.swim) {
    const per = week.swim.minutes / Math.max(1, week.swim.sessions);
    return Math.max(SWIM_SESSION_MIN_MIN, Math.min(SWIM_SESSION_MAX_MIN, Math.round(per / 5) * 5));
  }
  return null;
}

/**
 * Volume the capped sessions could not absorb, returned to the long ride.
 *
 * Without this, capping the midweek rides would silently delete training: a
 * fourteen-hour week whose midweek rides are capped at two and three hours has to
 * put the rest somewhere, and the long ride is where it belongs.
 */
/**
 * Guarantee the session marked "long" for a sport really is the longest that
 * sport does that week.
 *
 * Every session's size is computed independently (`sessionShare`/`sessionMinutes`
 * split the week's remaining volume evenly across however many sessions are left),
 * so nothing before this point actually checks the results against each other.
 * In practice a midweek "easy" or "recovery" ride routinely came out longer than
 * the week's designated long ride: the athlete was told their long ride was 2.3 h
 * while being handed a 3.25 h "recovery" ride the same week. The long-ride and
 * long-run ARCS (envelope-bike.ts, plan-load-model.ts) are the actual periodised
 * progression, so when a filler session outgrows them, the filler is capped down
 * — never the long session inflated up, which would silently override the arc.
 */
function enforceLongIsLongest(sessions: ScheduledSession[], minSessionKm: number): void {
  for (const sport of ["run", "bike", "swim"] as SportKey[]) {
    const ofSport = sessions.filter((s) => s.sport === sport);
    const long = ofSport.find((s) => s.kind === "long");
    if (!long) continue;
    // Compare and write back in whatever unit the LONG session itself uses — never
    // convert between km and minutes for the comparison and then write the
    // converted number back as if it were still in the other unit. An earlier
    // version of this function scaled km to "virtual metres" (x1000) to compare
    // across sports, then wrote that scaled number straight into distanceKm,
    // producing 18,000 km "runs". Every sport here is self-contained, so there is
    // no cross-sport comparison to do at all.
    const usesDuration = long.durationMin != null;
    const longMeasure = usesDuration ? (long.durationMin ?? 0) : (long.distanceKm ?? 0);
    const others = ofSport.filter((s) => s !== long);
    const maxOther = Math.max(0, ...others.map((s) => (usesDuration ? (s.durationMin ?? 0) : (s.distanceKm ?? 0))));
    if (maxOther <= longMeasure) continue;
    // A support runner's long run is deliberately kept modest, so the week's
    // other run session(s) can end up bigger than it. Shrinking them down to 90%
    // of the long run can push one under the athlete's own minimum (confirmed: a
    // 5.6 km easy run clamped to 3.6 km against a 4 km "long" run, under a 5 km
    // floor). The long session is the one deliberately sized small here, not the
    // floor, so raise it above the week's actual largest session instead of
    // shrinking another session below what the athlete asked for. Decided once
    // against the true maximum (not per-session against a stale long value) so a
    // week with more than one other session can't leave a later one still ahead.
    if (!usesDuration && sport === "run" && longMeasure * 0.9 < minSessionKm) {
      long.distanceKm = Math.round(maxOther * 1.05 * 10) / 10;
      continue;
    }
    for (const s of others) {
      const sMeasure = usesDuration ? (s.durationMin ?? 0) : (s.distanceKm ?? 0);
      if (sMeasure > longMeasure) {
        if (usesDuration) s.durationMin = Math.max(5, Math.round(longMeasure * 0.9));
        else s.distanceKm = Math.round(longMeasure * 0.9 * 10) / 10;
      }
    }
  }
}

/**
 * Guarantee the longest continuous swim the envelope builds toward is a session
 * that actually appears, not just a promise the athlete reads in a verdict.
 *
 * envelope-swim.ts computes `longestM` explicitly toward 1.2x race distance so an
 * open-water first-timer never meets an untrained distance on race day, but
 * nothing turned that number into a scheduled swim: every swim came out the same
 * proportional length, so the "longest swim" figure was fiction. The largest
 * swim already scheduled that week is bumped up to it (capped at the week's own
 * total metres, so this reshapes the week rather than adding training).
 */
function enforceLongestSwim(week: EnvelopeWeek, sessions: ScheduledSession[]): void {
  const target = week.swim?.longestM;
  if (!target || target <= 0 || !week.swim?.metres) return;
  const swims = sessions.filter((s) => s.sport === "swim" && s.distanceKm != null);
  if (!swims.length) return;
  const longest = swims.reduce((a, b) => ((b.distanceKm ?? 0) > (a.distanceKm ?? 0) ? b : a));
  const targetKm = Math.min(target / 1000, week.swim.metres / 1000);
  if ((longest.distanceKm ?? 0) < targetKm * 0.9) longest.distanceKm = Math.round(targetKm * 100) / 100;
}

function absorbIntoLongRide(week: EnvelopeWeek, sessions: ScheduledSession[]): void {
  if (!week.bike) return;
  const long = sessions.find((s) => s.sport === "bike" && s.kind === "long");
  if (!long) return;
  const others = sessions.filter((s) => s.sport === "bike" && s.kind !== "long");
  const plannedMin = others.reduce((a, s) => a + (s.durationMin ?? 0), 0) + (long.durationMin ?? 0);
  const targetMin = week.bike.hours * 60;
  const shortfall = targetMin - plannedMin;
  if (shortfall <= 5) return;
  // The long ride absorbs the remainder, but only up to a quarter beyond the arc
  // target the envelope set for it. Dumping every unallocated hour here turned a
  // 12-hour week into a single six-hour ride, which is a different plan, not a
  // fuller one. Anything that still does not fit is volume the week cannot hold,
  // and it is dropped rather than distorting the key session.
  const ceilingMin = Math.min(360, Math.round(week.bike.longRideHours * 60 * 1.25));
  long.durationMin = Math.max(long.durationMin ?? 0, Math.min(ceilingMin, Math.round(((long.durationMin ?? 0) + shortfall) / 5) * 5));
}

/** Brick runs grow with the event but stay short: transition practice, not volume. */
function brickRunMinutes(week: EnvelopeWeek): number {
  const longRun = week.run?.longRunKm ?? 0;
  if (longRun >= 28) return 45;   // full-distance triathlon
  if (longRun >= 18) return 30;   // half
  if (longRun >= 12) return 25;   // olympic
  return 15;                      // sprint
}
