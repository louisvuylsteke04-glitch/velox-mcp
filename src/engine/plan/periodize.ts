/**
 * The periodisation core: turn an athlete profile and a goal into a week-by-week
 * envelope across every sport they train.
 *
 * This is where the plan's shape is decided, deterministically and testably:
 * which sports matter and how much, how many sessions of each fit the athlete's
 * week, where the deloads and the taper fall, how much of each sport belongs in
 * each week, and whether the whole thing is actually achievable in the time the
 * athlete has. The LLM then coaches inside this envelope; it does not invent it.
 *
 * The cross-sport guards are the part that could not exist before. Running,
 * cycling and swimming each have their own sane ramp, but an athlete doing all
 * three can be inside every individual limit and still ramping their total load
 * far too fast. Every week is therefore checked against the combined budget as
 * well as its own sport's.
 */

import type { AthleteProfile } from "./profile";
import type { TrainingPreferences, SportVolume } from "../training-preferences";
import { THIN_RUN_WEEKS, THIN_SESSIONS_4W } from "./self-report";
import {
  type EnvelopeWeek, type PlanEnvelope, type Phase, type SportKey, type SportRole,
  type Verdict, type SessionBand,
  runHours, runWeekTss, bikeWeekTss, swimWeekTss,
} from "./types";
import { buildRunEnvelope } from "./envelope-run";
import { buildBikeEnvelope, bikeVerdict } from "./envelope-bike";
import { buildSwimEnvelope, swimVerdict } from "./envelope-swim";
import { TRI_LEGS } from "../plan-load-model";
import { sportForGoalType } from "../goal-sport";

// ── Cross-sport constants ─────────────────────────────────────────────────────

/** Impact weighting: the injury-risk view of load. Matches lib/multisport-load. */
const MECH_W: Record<SportKey, number> = { run: 1.0, bike: 0.25, swim: 0.1 };
/** Ceiling on week-over-week growth in TOTAL load. Tighter than any single sport's
 *  ramp because it compounds across three of them. */
const COMBINED_TSS_RAMP = 1.08;
/** Ceiling on week-over-week growth in impact-weighted load. Bone and tendon adapt
 *  more slowly than the cardiovascular system, so this is the binding constraint
 *  for a runner and the reason a cyclist can add hours faster. */
const MECHANICAL_RAMP = 1.10;
/** A deload lands every 4th week, every 3rd for masters athletes. */
const RECOVERY_EVERY = 4;
const RECOVERY_EVERY_MASTERS = 3;
const MASTERS_AGE = 50;
/** Assumed session length when the athlete has set no cap, for the time budget. */
const DEFAULT_SESSION_MINUTES = 90;
/** Bricks start once the plan is this far through its build. */
const BRICK_START_FRACTION = 0.45;

/** Sessions per week by sport and role, before the athlete's own time is applied. */
const SESSION_BANDS: Record<SportKey, Record<Exclude<SportRole, "off">, SessionBand>> = {
  run:  { primary: { min: 3, max: 6 }, support: { min: 1, max: 2 } },
  bike: { primary: { min: 3, max: 5 }, support: { min: 1, max: 2 } },
  // Swimming is frequency-first: even as a support sport it wants two swims,
  // because feel for the water decays faster than fitness does.
  swim: { primary: { min: 2, max: 4 }, support: { min: 1, max: 2 } },
};

export type PeriodizeInput = {
  profile: AthleteProfile;
  goal: {
    type: string;
    sport: string;
    raceDate: string | null;
    /** Event distance in km, for bike and swim events. */
    eventDistanceKm: number | null;
  } | null;
  totalWeeks: number;
  weeksToRace: number | null;
  /** Every active goal is a running goal (RUN_ONLY_SESSIONS): no bike or swim
   *  support, whatever the athlete already does or opted into. See run-only.ts. */
  runOnly?: boolean;
  /** The athlete's sign-up volume answers, passed only under SELF_REPORT_START.
   *  Each sport uses them only when its synced history is thin (#121, C1). */
  selfReport?: SportVolume | null;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

function normaliseExperience(level: string | null): "beginner" | "intermediate" | "advanced" {
  const l = (level ?? "").toLowerCase();
  if (l.includes("begin") || l.includes("new") || l.includes("novice")) return "beginner";
  if (l.includes("adv") || l.includes("elite") || l.includes("experien")) return "advanced";
  return "intermediate";
}

/**
 * Which sports this plan trains, and how much each one matters.
 *
 * The goal decides the primary sport. Everything else is a support sport IF the
 * athlete already does it or has opted into it: a marathon runner who never rides
 * should not be handed bike sessions, but a marathon runner who rides twice a week
 * should keep riding, because taking it away would cut their aerobic base and
 * their enjoyment for no gain.
 */
export function assignRoles(
  profile: AthleteProfile,
  goalType: string | null,
  /**
   * The sport stored on the goal. Needed because "improve_fitness" carries no
   * sport in its type: a cyclist who picked Base Fitness has sport='bike' on the
   * goal row, and deriving from the type alone handed them a running plan built
   * on a run history of zero, with 1.4 km "long runs".
   */
  goalSportOverride?: string | null,
  /** Running goals get running only (#121). Ignored unless the goal is a run. */
  runOnly: boolean = false,
): Record<SportKey, SportRole> {
  const derived = goalType ? sportForGoalType(goalType) : "run";
  const stored = goalSportOverride;
  const goalSport = (stored === "run" || stored === "bike" || stored === "swim" || stored === "triathlon")
    ? stored
    : derived;
  const prefsCross = profile.prefs.cross_training;
  const opted = (s: SportKey) => prefsCross.willing && prefsCross.types.includes(s as "bike" | "swim");

  if (goalSport === "triathlon") {
    return { swim: "primary", bike: "primary", run: "primary" };
  }

  const roles: Record<SportKey, SportRole> = { run: "off", bike: "off", swim: "off" };
  roles[goalSport as SportKey] = "primary";
  if (runOnly && goalSport === "run") return roles;

  for (const s of ["run", "bike", "swim"] as SportKey[]) {
    if (roles[s] === "primary") continue;
    const active = s === "run" ? profile.run.sessions4w > 0
      : s === "bike" ? profile.bike.sessions4w > 0
      : profile.swim.sessions4w > 0;
    // Running is kept for a cyclist or swimmer even without history: it is the
    // cheapest aerobic stimulus available and it protects bone density. Bike and
    // swim are only added when the athlete already does them or asked for them.
    if (active || opted(s) || (s === "run" && goalSport !== "run")) roles[s] = "support";
  }
  return roles;
}

/**
 * How many sessions of each sport fit this athlete's week.
 *
 * The athlete's stated training days are a hard ceiling on DAYS, not on sessions:
 * a triathlete training six days a week can hold eight sessions because a swim and
 * an easy run can share a day. Doubles are allowed up to a third of the days.
 */
export function assignSessions(
  roles: Record<SportKey, SportRole>,
  prefs: TrainingPreferences,
  profile: AthleteProfile,
): Record<SportKey, number> {
  const days = Math.max(1, Math.min(7, prefs.available_days || prefs.preferred_days.length || 5));
  const capacity = Math.floor(days * 1.35); // doubles on roughly a third of days
  const out: Record<SportKey, number> = { run: 0, bike: 0, swim: 0 };

  // Start every active sport at the minimum its role demands, but also at enough
  // sessions to carry the volume it will hold. Twelve hours of riding across three
  // sessions is four hours a ride, which turns every midweek session into an
  // endurance ride and leaves no room for a real long one.
  const active = (Object.keys(roles) as SportKey[]).filter((s) => roles[s] !== "off");
  const HOURS_PER_RIDE = 2.5;
  const KM_PER_RUN = 14;
  const METRES_PER_SWIM = 2500;
  for (const s of active) {
    const band = SESSION_BANDS[s][roles[s] as Exclude<SportRole, "off">];
    const byVolume = s === "bike" ? Math.ceil(profile.bike.weeklyHours / HOURS_PER_RIDE)
      : s === "run" ? Math.ceil(profile.run.weeklyKm / KM_PER_RUN)
      : Math.ceil(profile.swim.weeklyMetres / METRES_PER_SWIM);
    out[s] = Math.min(band.max, Math.max(band.min, Number.isFinite(byVolume) ? byVolume : band.min));
  }

  // Spend what is left on the primary sports first, then support, never past the
  // band's ceiling or what the athlete's own history says they will actually do.
  const historyCeiling = (s: SportKey) => {
    const n = s === "run" ? profile.run.sessions4w : s === "bike" ? profile.bike.sessions4w : profile.swim.sessions4w;
    // A quarter of the last four weeks' sessions is their real weekly rate. Allow
    // one more than that: a plan may stretch an athlete, not transform them.
    return n > 0 ? Math.ceil(n / 4) + 1 : Infinity;
  };
  const order = [...active].sort((a, b) => (roles[a] === "primary" ? 0 : 1) - (roles[b] === "primary" ? 0 : 1));
  let used = order.reduce((sum, s) => sum + out[s], 0);
  let progressed = true;
  while (used < capacity && progressed) {
    progressed = false;
    for (const s of order) {
      if (used >= capacity) break;
      const band = SESSION_BANDS[s][roles[s] as Exclude<SportRole, "off">];
      if (out[s] < Math.min(band.max, historyCeiling(s))) {
        out[s]++; used++; progressed = true;
      }
    }
  }
  return out;
}

/** Phase, deload and taper layout for the whole horizon. */
export function buildPhaseLayout(totalWeeks: number, weeksToRace: number | null, goalType: string, isMasters: boolean) {
  const LONG_TAPER = new Set(["marathon", "ultra", "triathlon_full"]);
  const taperLen = weeksToRace == null ? 0
    : Math.min(LONG_TAPER.has(goalType) ? 3 : 2, Math.max(0, totalWeeks - 1));
  const buildWeeks = totalWeeks - taperLen;
  const recoveryEvery = isMasters ? RECOVERY_EVERY_MASTERS : RECOVERY_EVERY;
  const taperMultipliers = taperLen === 3 ? [0.75, 0.6, 0.5] : taperLen === 2 ? [0.7, 0.55] : taperLen === 1 ? [0.6] : [];

  const layout: { phase: Phase; isRecovery: boolean; taperMultiplier: number | null }[] = [];
  for (let w = 1; w <= buildWeeks; w++) {
    const isRecovery = w > 1 && w % recoveryEvery === 0;
    const frac = buildWeeks > 1 ? (w - 1) / (buildWeeks - 1) : 1;
    const positional: Phase = frac < 0.4 ? "base" : frac < 0.8 ? "build" : "peak";
    layout.push({ phase: isRecovery ? "recovery" : positional, isRecovery, taperMultiplier: null });
  }
  for (let i = 0; i < taperLen; i++) {
    layout.push({ phase: "taper", isRecovery: false, taperMultiplier: taperMultipliers[i] });
  }
  return { layout, buildWeeks, taperLen };
}

/** The swim and bike distances a triathlon leg demands, in metres and km. */
function triLegs(goalType: string) {
  return TRI_LEGS[goalType] ?? null;
}

/**
 * Estimated event duration in hours for the bike side, from the athlete's own
 * riding speed. Falls back to a typical age-group speed so an event still has a
 * duration to build toward when the athlete's rides carry no speed.
 */
function bikeEventHours(goalType: string, eventDistanceKm: number | null, avgSpeedKmh: number | null): number | null {
  const legKm = goalType.startsWith("triathlon") ? triLegs(goalType)?.bike ?? null
    : goalType === "bike_event" ? eventDistanceKm
    : null;
  if (legKm == null || legKm <= 0) return null;
  const speed = avgSpeedKmh != null && avgSpeedKmh >= 15 && avgSpeedKmh <= 45 ? avgSpeedKmh : 27;
  return r1(legKm / speed);
}

/** The race swim distance in metres, for a triathlon leg or a swim event. */
function raceSwimMetres(goalType: string, eventDistanceKm: number | null): number | null {
  if (goalType.startsWith("triathlon")) {
    const legs = triLegs(goalType);
    return legs ? Math.round(legs.swim * 1000) : null;
  }
  if (goalType === "swim_event" && eventDistanceKm != null && eventDistanceKm > 0) {
    return Math.round(eventDistanceKm * 1000);
  }
  return null;
}

export function buildPlanEnvelope(input: PeriodizeInput): PlanEnvelope {
  const { profile, goal, totalWeeks, weeksToRace, runOnly = false, selfReport = null } = input;
  const goalType = goal?.type ?? "improve_fitness";
  const experience = normaliseExperience(profile.experienceLevel);
  const isMasters = profile.ageYears != null && profile.ageYears >= MASTERS_AGE;
  const injuryActive = profile.injury.active || profile.medical.raised;

  const roles = assignRoles(profile, goalType, goal?.sport ?? null, runOnly);
  const sessions = assignSessions(roles, profile.prefs, profile);
  const { layout, buildWeeks } = buildPhaseLayout(totalWeeks, weeksToRace, goalType, isMasters);

  // Opening damp: an athlete arriving hurt, exhausted or off the back of a layoff
  // starts with a consolidation week rather than an overload one.
  let damp = 1;
  if (profile.recentHighFatigue) damp *= 0.9;
  if (injuryActive) damp *= 0.85;
  damp = Math.max(0.8, damp);
  if (profile.missedTraining.volumeFactor < 1) damp = Math.min(damp, profile.missedTraining.volumeFactor);

  const eventHours = bikeEventHours(goalType, goal?.eventDistanceKm ?? null, profile.bike.avgSpeedKmh);
  const swimRaceM = raceSwimMetres(goalType, goal?.eventDistanceKm ?? null);

  // Sign-up volume, per sport, only where synced history is too thin to stand on.
  const reports = selfReportsFor(profile, roles, selfReport);

  const run = buildRunEnvelope({
    role: roles.run,
    experience,
    recentWeeklyKm: profile.run.weeklyKm,
    weeklyKmHistory: profile.run.weeklyKmHistory,
    recentLongRunKm: profile.run.longestKm,
    easyPaceSecPerKm: profile.run.easyPaceSecPerKm,
    // Combined-sport fitness: a triathlete's capacity is not their running alone.
    // The run curve's capacity floor (computeStartingVolume in plan-load-model.ts)
    // reads CTL as evidence of RUNNING fitness and derives a week-1 km floor from
    // it. profile.load.ctl is the COMBINED multi-sport figure: a cyclist doing
    // their first triathlon can show CTL 80 from riding alone, which the run
    // curve then read as "this athlete can already handle ~47 km/week of
    // running" for someone who has run zero kilometres. Only pass CTL through
    // when the athlete has actually been running recently; otherwise the curve
    // correctly falls back to the conservative experience-level default.
    ctl: profile.run.sessions4w > 0 && profile.load.ctl > 0 ? profile.load.ctl : null,
    acwr: null,
    goalType,
    eventDistanceKm: goal?.eventDistanceKm ?? null,
    totalWeeks,
    weeksToRace,
    ageYears: profile.ageYears,
    recentHighFatigue: profile.recentHighFatigue,
    injuryActive,
    missedTrainingFactor: profile.missedTraining.volumeFactor,
    sessions: sessions.run,
    phases: layout,
    selfReportedWeeklyKm: reports.run,
  });

  const bike = buildBikeEnvelope({
    role: roles.bike,
    experience,
    recentHours: profile.bike.weeklyHours,
    recentLongRideHours: profile.bike.longestRideHours,
    eventHours,
    sessions: sessions.bike,
    phases: layout,
    isMasters,
    injuryActive,
    openingDamp: damp,
    selfReportedHours: reports.bike,
  });

  const swim = buildSwimEnvelope({
    role: roles.swim,
    experience,
    recentMetres: profile.swim.weeklyMetres,
    recentHours: profile.swim.weeklyHours,
    distanceRecorded: profile.swim.distanceRecorded,
    raceDistanceM: swimRaceM,
    goalType,
    cssSecPer100m: profile.swim.css.value,
    sessions: sessions.swim,
    phases: layout,
    isMasters,
    openingDamp: damp,
    selfReportedMetres: reports.swim,
  });

  // ── Assemble, then apply the cross-sport guards ─────────────────────────────
  const isTri = goalType.startsWith("triathlon");
  const weeks: EnvelopeWeek[] = layout.map((l, i) => {
    const rw = run.weeks[i], bw = bike[i], sw = swim[i];
    const tssTotal = (rw?.tss ?? 0) + (bw?.tss ?? 0) + (sw?.tss ?? 0);
    const mechanical = Math.round(
      (rw?.tss ?? 0) * MECH_W.run + (bw?.tss ?? 0) * MECH_W.bike + (sw?.tss ?? 0) * MECH_W.swim,
    );
    const hours = r1(
      runHours(rw?.km ?? 0, profile.run.easyPaceSecPerKm) + (bw?.hours ?? 0) + (sw?.minutes ?? 0) / 60,
    );
    // Bricks belong in the back half of a triathlon build, once there is enough
    // bike volume for the run off it to teach anything, and never in a deload.
    const brick = isTri && !l.isRecovery && l.taperMultiplier == null
      && i >= Math.floor(buildWeeks * BRICK_START_FRACTION);
    return {
      week_number: i + 1,
      phase: l.phase,
      isRecovery: l.isRecovery,
      brick,
      run: rw, bike: bw, swim: sw,
      tssTotal, mechanical, hours,
    };
  });

  if (isTri) applyTriathlonBalance(weeks, goalType, profile.run.easyPaceSecPerKm);
  applyCombinedRampGuards(weeks, profile);
  // The athlete's own current weekly training time, in the same units the budget
  // works in, so an athlete already training a lot is not capped below what they
  // are visibly already doing.
  const currentHours = r1(
    runHours(profile.run.weeklyKm, profile.run.easyPaceSecPerKm)
    + profile.bike.weeklyHours
    + profile.swim.weeklyHours,
  );
  const timeVerdict = applyTimeBudget(weeks, profile.prefs, currentHours);
  // Run LAST: both guards above can flatten a week, and when the time budget binds
  // it caps a build week and its following deload to the same ceiling, which
  // quietly deletes the recovery week. The deload is not negotiable, so it is
  // re-imposed relative to whatever the week before ended up being.
  enforceDeloadRelief(weeks);
  enforceTaperDescent(weeks, !!goal?.raceDate);

  // ── Verdicts: what this plan can and cannot honestly prepare ────────────────
  const verdicts: Verdict[] = [];
  if (roles.run !== "off" && run.verdict.note) {
    verdicts.push({ code: "run_long_run", adequate: run.verdict.adequate, note: run.verdict.note });
  }
  if (roles.bike !== "off") {
    const v = bikeVerdict(bike, eventHours, profile.bike.longestRideHours);
    if (v.note) verdicts.push({ code: "bike_long_ride", adequate: v.adequate, note: v.note });
  }
  if (roles.swim !== "off") {
    const v = swimVerdict(swim, swimRaceM, profile.swim.longestSwimM, profile.swim.distanceRecorded);
    if (v.note) verdicts.push({ code: "swim_longest", adequate: v.adequate, note: v.note });
  }
  if (timeVerdict) verdicts.push(timeVerdict);

  const selfReportStart = (Object.keys(reports) as SportKey[]).filter((k) => reports[k] != null);
  return {
    weeks, roles, verdicts, rationale: buildRationale(roles, weeks, run.rationale, sessions, isTri),
    ...(selfReportStart.length ? { selfReportStart } : {}),
  };
}

/**
 * Which sign-up answers anchor which sport (#121, C1). Running uses the report
 * when the 8-week history has fewer than two non-zero weeks; cycling and
 * swimming when they are a primary sport with fewer than two sessions in four
 * weeks. Synced data wins in every other case.
 */
export function selfReportsFor(
  profile: AthleteProfile,
  roles: Record<SportKey, SportRole>,
  v: SportVolume | null,
): Record<SportKey, number | null> {
  const out: Record<SportKey, number | null> = { run: null, bike: null, swim: null };
  if (!v) return out;
  const runThin = profile.run.weeklyKmHistory.filter((km) => km > 0).length < THIN_RUN_WEEKS;
  if (roles.run === "primary" && runThin && (v.run_weekly_km ?? 0) > 0) out.run = v.run_weekly_km as number;
  if (roles.bike === "primary" && profile.bike.sessions4w < THIN_SESSIONS_4W && (v.bike_weekly_hours ?? 0) > 0) {
    out.bike = v.bike_weekly_hours as number;
  }
  if (roles.swim === "primary" && profile.swim.sessions4w < THIN_SESSIONS_4W
    && (v.swim_sessions_per_week ?? 0) > 0 && (v.swim_session_metres ?? 0) > 0) {
    out.swim = (v.swim_sessions_per_week as number) * (v.swim_session_metres as number);
  }
  return out;
}

/**
 * Hold the whole plan inside a safe combined ramp.
 *
 * Each sport already ramps sanely on its own, but three sane ramps still compound.
 * Where a week grows too fast in total load or in impact-weighted load, every
 * sport in that week is scaled back proportionally, which preserves the balance
 * the plan intends while bringing the total back inside the limit.
 */
function applyCombinedRampGuards(weeks: EnvelopeWeek[], profile: AthleteProfile): void {
  // The athlete's current weekly load is the starting reference, so week 1 cannot
  // itself be a spike relative to what they are already doing. Both references have
  // to be seeded: leaving the mechanical one at zero made the `prevMech > 0` test
  // fail on week 1, so the guard silently skipped the single most important week
  // to get right.
  const w7 = profile.load.weekLoad7;
  let prevTss = w7.total > 0 ? w7.total : 0;
  let prevMech = w7.total > 0
    ? Math.round(w7.run * MECH_W.run + w7.bike * MECH_W.bike + w7.swim * MECH_W.swim)
    : 0;

  for (const w of weeks) {
    // Recovery and taper weeks are deliberate reductions; they never need capping.
    if (w.isRecovery || w.phase === "taper") {
      prevTss = Math.max(prevTss, w.tssTotal);
      prevMech = Math.max(prevMech, w.mechanical);
      continue;
    }
    if (prevTss > 0 && prevMech > 0) {
      const tssCap = prevTss * COMBINED_TSS_RAMP;
      const mechCap = prevMech * MECHANICAL_RAMP;
      const scale = Math.min(
        w.tssTotal > tssCap ? tssCap / w.tssTotal : 1,
        w.mechanical > mechCap ? mechCap / w.mechanical : 1,
      );
      if (scale < 1) scaleWeek(w, scale);
    }
    prevTss = w.tssTotal;
    prevMech = w.mechanical;
  }
}

/**
 * Keep a triathlon week's three sports in a sane proportion to each other.
 *
 * Each sport's envelope is built from that sport's own history and its own sane
 * ramp, which is right in isolation and wrong in combination: three independently
 * reasonable curves can add up to a week that is 60% cycling and 10% swimming
 * when it should be closer to 50/15. Worse, whichever sport ramps fastest crowds
 * the others out once the week hits any ceiling. In one 20-week Ironman envelope
 * that made weekly swimming FALL from 10.1 km to 8.1 km across the build.
 *
 * Coaches allocate long-course training by share of weekly TIME, weighted toward
 * the discipline that takes the largest part of race day. These are those shares,
 * applied as BOUNDS rather than as targets, so an athlete's own emphasis survives
 * as long as it is not extreme.
 */
const TRI_HOUR_SHARE: Record<string, { swim: number; bike: number; run: number }> = {
  triathlon_sprint:  { swim: 0.22, bike: 0.43, run: 0.35 },
  triathlon_olympic: { swim: 0.20, bike: 0.45, run: 0.35 },
  triathlon_half:    { swim: 0.15, bike: 0.50, run: 0.35 },
  triathlon_full:    { swim: 0.12, bike: 0.53, run: 0.35 },
};
/** How far a sport may sit from its target share before it is pulled back. */
const SHARE_TOLERANCE = 0.08;

function applyTriathlonBalance(weeks: EnvelopeWeek[], goalType: string, easyPace: number | null): void {
  const target = TRI_HOUR_SHARE[goalType];
  if (!target) return;

  for (const w of weeks) {
    // The taper has its own per-sport logic, and race week contains the event
    // itself: rebalancing a race week would scale the marathon leg of an Ironman
    // down to something that is not the race.
    if (!w.run || !w.bike || !w.swim || w.phase === "taper") continue;

    const swimH = w.swim.minutes / 60;
    const bikeH = w.bike.hours;
    const runH = runHours(w.run.km, easyPace);
    const total = swimH + bikeH + runH;
    if (total <= 0) continue;

    // TRIM ONLY. A sport sitting above its share is pulled back; a sport sitting
    // below its share is left alone rather than inflated, because week 1 must
    // start where the athlete actually is. Trimming the greedy sport is what stops
    // the others being crowded out later, which was the real problem.
    const trimmed = (actual: number, targetShare: number) => {
      const hi = (targetShare + SHARE_TOLERANCE) * total;
      return actual > hi ? hi : actual;
    };

    const newSwimH = trimmed(swimH, target.swim);
    const newBikeH = trimmed(bikeH, target.bike);
    const newRunH = trimmed(runH, target.run);

    if (newSwimH < swimH && w.swim.minutes > 0) {
      const mins = Math.round(newSwimH * 60);
      if (w.swim.metres != null) w.swim.metres = Math.round(w.swim.metres * (mins / w.swim.minutes));
      w.swim.minutes = mins;
    }
    if (newBikeH < bikeH) {
      w.bike.hours = r1(newBikeH);
      w.bike.longRideHours = r1(Math.min(w.bike.longRideHours, w.bike.hours));
    }
    if (newRunH < runH && runH > 0) {
      const km = r1(w.run.km * (newRunH / runH));
      w.run.longRunKm = r1(Math.min(w.run.longRunKm, km * 0.55));
      w.run.km = km;
    }

    recomputeWeek(w);
  }
}

/**
 * Guarantee that a recovery week is actually a recovery week.
 *
 * A deload only works if it is meaningfully lighter than the training it follows.
 * Any earlier pass that caps weeks (the ramp guards, and especially the time
 * budget, which pins several consecutive weeks to the same ceiling) can leave a
 * "deload" carrying the same load as the week before it, which is just a normal
 * week wearing a label. This restores the relationship after all other scaling.
 */
const DELOAD_FRACTION = 0.8;

function enforceDeloadRelief(weeks: EnvelopeWeek[]): void {
  for (let i = 1; i < weeks.length; i++) {
    const w = weeks[i];
    if (!w.isRecovery) continue;
    const prev = weeks[i - 1];
    if (prev.tssTotal <= 0 || w.tssTotal <= 0) continue;
    const target = prev.tssTotal * DELOAD_FRACTION;
    if (w.tssTotal > target) scaleWeek(w, target / w.tssTotal);
  }
}

/**
 * Fit a week into a time budget the way a coach does: take the hours out of the
 * easy filler, and protect the sessions that carry the adaptation.
 *
 * Scaling every sport down equally looks fair and trains badly. It shrinks the
 * long ride and the long run, which are the two sessions the whole block exists
 * to build, and on a multi-sport plan it quietly strangles the smallest sport:
 * in a 20-week Ironman envelope, proportional trimming made weekly swimming FALL
 * from 10.2 km to 8.4 km through the build, because the run curve kept growing
 * into the same fixed ceiling.
 *
 * So the excess comes out of easy volume first, across all sports in proportion
 * to how much easy volume each has. Only if that is not enough do the key
 * sessions themselves come down.
 */
function trimToHours(w: EnvelopeWeek, targetHours: number): void {
  const easyPaceGuess = 360;
  const runFillerH = w.run ? Math.max(0, runHours(Math.max(0, w.run.km - w.run.longRunKm), easyPaceGuess)) : 0;
  const bikeFillerH = w.bike ? Math.max(0, w.bike.hours - w.bike.longRideHours) : 0;
  // Swim filler is whatever sits above two sessions' worth: frequency is the part
  // of swimming that matters, so it is the last thing to give.
  const swimFloorMin = w.swim ? Math.min(w.swim.minutes, 2 * 30) : 0;
  const swimFillerH = w.swim ? Math.max(0, (w.swim.minutes - swimFloorMin) / 60) : 0;

  const totalFiller = runFillerH + bikeFillerH + swimFillerH;
  let excess = w.hours - targetHours;

  if (totalFiller > 0 && excess > 0) {
    const take = Math.min(excess, totalFiller);
    const frac = take / totalFiller;
    if (w.run && runFillerH > 0) {
      const keepKm = w.run.km - (w.run.km - w.run.longRunKm) * frac;
      w.run.km = r1(Math.max(w.run.longRunKm, keepKm));
      // A heavy trim (frac near 1) drives keepKm toward longRunKm, which pushes
      // the long run's SHARE of the week toward 100% rather than its own volume
      // actually falling. The long run has to come down with the week, capped at
      // its normal ceiling, or "long run 19 km in a 34 km week" is the result.
      w.run.longRunKm = r1(Math.min(w.run.longRunKm, w.run.km * 0.55));
    }
    if (w.bike && bikeFillerH > 0) {
      w.bike.hours = r1(Math.max(w.bike.longRideHours, w.bike.hours - bikeFillerH * frac));
    }
    if (w.swim && swimFillerH > 0) {
      const mins = Math.round(w.swim.minutes - swimFillerH * 60 * frac);
      const ratio = w.swim.minutes > 0 ? mins / w.swim.minutes : 1;
      w.swim.minutes = Math.max(swimFloorMin, mins);
      if (w.swim.metres != null) w.swim.metres = Math.round(w.swim.metres * ratio);
    }
    excess -= take;
  }

  recomputeWeek(w);

  // Still over: the key sessions have to give too, which is the honest outcome
  // for an athlete whose event genuinely needs more time than they have.
  if (w.hours > targetHours) scaleWeek(w, targetHours / w.hours);
}

/** Recompute a week's derived totals from its per-sport numbers. */
function recomputeWeek(w: EnvelopeWeek): void {
  if (w.run) w.run.tss = runWeekTss(w.run.km, null);
  if (w.bike) w.bike.tss = bikeWeekTss(w.bike.hours);
  if (w.swim) w.swim.tss = swimWeekTss(w.swim.minutes);
  w.tssTotal = (w.run?.tss ?? 0) + (w.bike?.tss ?? 0) + (w.swim?.tss ?? 0);
  w.mechanical = Math.round(
    (w.run?.tss ?? 0) * MECH_W.run + (w.bike?.tss ?? 0) * MECH_W.bike + (w.swim?.tss ?? 0) * MECH_W.swim,
  );
  w.hours = r1(runHours(w.run?.km ?? 0, null) + (w.bike?.hours ?? 0) + (w.swim?.minutes ?? 0) / 60);
}

/**
 * Make the taper actually taper, in every sport.
 *
 * Each sport's envelope tapers off its OWN rolling working volume, and the
 * cross-sport passes deliberately skip taper weeks. The combination let the taper
 * come out heavier than the block it is supposed to unload: in one 20-week Ironman
 * envelope the first taper week was the biggest swim week of the entire plan
 * (9.9 km against a peak of 8.3), and race week carried near-peak riding and
 * swimming on top of the race itself.
 *
 * So the taper is clamped against the real peak of the build, week by week, and
 * race week is cut to an opener: the event is the training that day.
 */
const TAPER_STEPS = [0.7, 0.55, 0.45];
const RACE_WEEK_FRACTION = 0.35;

function enforceTaperDescent(weeks: EnvelopeWeek[], hasRace: boolean): void {
  const taper = weeks.filter((w) => w.phase === "taper");
  if (!taper.length) return;
  const build = weeks.filter((w) => w.phase !== "taper" && !w.isRecovery);
  const peak = Math.max(...build.map((w) => w.tssTotal), 0);
  if (peak <= 0) return;

  taper.forEach((w, i) => {
    const isRaceWeek = hasRace && w === taper[taper.length - 1];
    // Later taper weeks are lighter; the race week is lighter still.
    const step = isRaceWeek ? RACE_WEEK_FRACTION : (TAPER_STEPS[Math.min(i, TAPER_STEPS.length - 1)] ?? 0.5);
    const ceiling = peak * step;
    if (w.tssTotal > ceiling) scaleWeek(w, ceiling / w.tssTotal);
  });

  // And it must descend monotonically, whatever the individual ceilings worked out at.
  for (let i = 1; i < taper.length; i++) {
    const prev = taper[i - 1], cur = taper[i];
    if (cur.tssTotal > prev.tssTotal && cur.tssTotal > 0) scaleWeek(cur, (prev.tssTotal * 0.9) / cur.tssTotal);
  }
}

/** Scale every sport in a week by the same factor, keeping its internal balance. */
function scaleWeek(w: EnvelopeWeek, scale: number): void {
  if (w.run) {
    w.run.km = r1(w.run.km * scale);
    w.run.longRunKm = r1(Math.min(w.run.longRunKm, w.run.km * 0.5));
    w.run.tss = Math.round(w.run.tss * scale);
  }
  if (w.bike) {
    w.bike.hours = r1(w.bike.hours * scale);
    w.bike.longRideHours = r1(Math.min(w.bike.longRideHours, w.bike.hours));
    w.bike.tss = Math.round(w.bike.tss * scale);
  }
  if (w.swim) {
    if (w.swim.metres != null) w.swim.metres = Math.round(w.swim.metres * scale);
    w.swim.minutes = Math.round(w.swim.minutes * scale);
    w.swim.tss = Math.round(w.swim.tss * scale);
  }
  w.tssTotal = (w.run?.tss ?? 0) + (w.bike?.tss ?? 0) + (w.swim?.tss ?? 0);
  w.mechanical = Math.round(
    (w.run?.tss ?? 0) * MECH_W.run + (w.bike?.tss ?? 0) * MECH_W.bike + (w.swim?.tss ?? 0) * MECH_W.swim,
  );
  w.hours = r1(w.hours * scale);
}

/**
 * Keep the plan inside the time the athlete actually has.
 *
 * An event can demand more training than someone's life allows. The honest
 * response is to build the best plan that fits and say so, not to prescribe
 * fifteen hours to someone who told us they have eight.
 */
function applyTimeBudget(weeks: EnvelopeWeek[], prefs: TrainingPreferences, currentWeeklyHours: number): Verdict | null {
  const days = Math.max(1, Math.min(7, prefs.available_days || prefs.preferred_days.length || 5));

  // What the athlete already trains is the strongest evidence of the time they
  // have: someone doing sixteen hours a week has not told us they have twelve.
  // Allow real growth on top of it, since a plan should stretch an athlete.
  const fromHistory = currentWeeklyHours > 0 ? currentWeeklyHours * 1.35 : 0;

  // What they stated. `max_session_minutes` is a WEEKDAY session cap in the
  // preferences UI, and the long weekend session is explicitly exempt, so the
  // weekly ceiling carries headroom rather than being days x cap exactly. When no
  // cap is set we have no stated constraint at all, and inventing a default one
  // would silently flatten the plan of anyone who never filled that field in.
  const fromPrefs = prefs.max_session_minutes != null
    ? ((days * prefs.max_session_minutes) / 60) * 1.25
    : Math.max(fromHistory, days * DEFAULT_SESSION_MINUTES / 60);

  const budgetH = r1(Math.max(fromPrefs, fromHistory, 2));

  let capped = 0;
  for (const w of weeks) {
    if (w.hours > budgetH) {
      capped++;
      trimToHours(w, budgetH);
    }
  }
  if (!capped) return null;
  return {
    code: "time_budget",
    adequate: false,
    note: `${capped} week${capped === 1 ? "" : "s"} of this plan wanted more training time than about ${budgetH} hours, which is what your ${days} available days and your recent training suggest you have. Those weeks have been trimmed to fit, so this is the best version of the plan that fits your week rather than an ideal one you would have to skip sessions from. Adding a day, or lengthening one session, would let it build further.`,
  };
}

function buildRationale(
  roles: Record<SportKey, SportRole>,
  weeks: EnvelopeWeek[],
  runRationale: string,
  sessions: Record<SportKey, number>,
  isTri: boolean,
): string {
  const parts: string[] = [];
  const peak = weeks.reduce((m, w) => (w.tssTotal > m.tssTotal ? w : m), weeks[0]);
  if (roles.run !== "off") parts.push(roles.run === "primary" ? runRationale : `${sessions.run} supporting runs a week`);
  if (roles.bike !== "off") {
    const peakBike = Math.max(...weeks.map((w) => w.bike?.hours ?? 0));
    const peakLong = Math.max(...weeks.map((w) => w.bike?.longRideHours ?? 0));
    parts.push(`${sessions.bike} rides a week building to ${r1(peakBike)} h with a longest ride of ${r1(peakLong)} h`);
  }
  if (roles.swim !== "off") {
    const peakSwim = Math.max(...weeks.map((w) => w.swim?.metres ?? 0));
    parts.push(peakSwim > 0
      ? `${sessions.swim} swims a week building to ${(peakSwim / 1000).toFixed(1)} km`
      : `${sessions.swim} swims a week`);
  }
  const brickWeeks = weeks.filter((w) => w.brick).length;
  const tail = isTri && brickWeeks
    ? ` Brick sessions appear in ${brickWeeks} weeks so the legs learn to run off the bike.`
    : "";
  return `${parts.join("; ")}. Peak week about ${peak?.tssTotal ?? 0} TSS across ${r1(peak?.hours ?? 0)} h.${tail}`;
}
