/**
 * Structured quality sessions (#121, C3 + C6, STRUCTURED_SESSIONS).
 *
 * A quality session used to be a type, a distance and a zone: "Threshold, 9 km,
 * zone4". Only the describe pass, inside its 14-day window, ever said how to run
 * it. This builds the warm-up, the main set and the cool-down for every quality
 * session in the plan, deterministically, with targets from the athlete's own
 * anchors (run paces from PACE_ANCHORS, FTP, CSS).
 *
 * Two rules it never breaks:
 *   - the segments add up EXACTLY to the distance or duration the engine already
 *     settled, so no load number in the plan changes;
 *   - it only ever describes the session, it never decides how hard the week is.
 *
 * Progression (C6): within a phase, reps lengthen or multiply from the first week
 * to the last, and a week with two quality sessions in one sport gets two
 * different structures (intervals, then a continuous effort).
 *
 * Easy, recovery and long sessions get no segments. The legacy engine is
 * untouched.
 */

import type { GeneratedPlan, PaceZone, SessionSegment } from "../types/calendar";
import type { AthleteProfile } from "./profile";
import type { EnvelopeWeek, PlanEnvelope, SportKey } from "./types";
import { fmtPace } from "../zones/goal-paces";
import { fmtSwimPace } from "./thresholds";

export type StructureContext = {
  /** The goal's race pace (sec/km), when the athlete set a goal time. */
  racePaceSecPerKm: number | null;
  goalType: string;
};

type Anchors = {
  easy: number | null;
  threshold: number | null;
  interval: number | null;
  racePace: number | null;
  ftp: number | null;
  css: number | null;
  weakSwimmer: boolean;
};

const QUALITY = new Set(["tempo", "threshold", "interval"]);
const SHORT_EVENTS = new Set(["5k", "10k", "triathlon_sprint"]);
const LONG_EVENTS = new Set(["half_marathon", "marathon", "ultra", "triathlon_half", "triathlon_full"]);
/** Pace bands either side of a run target, sec/km (Louis, #121). */
const RUN_BAND = 3;
const SWIM_BAND = 2;

const r1 = (n: number) => Math.round(n * 10) / 10;
const half = (n: number) => Math.round(n * 2) / 2;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** Pick from a progression by how far through the phase the week is (0..1). */
const step = <T>(xs: T[], progress: number): T => xs[Math.min(xs.length - 1, Math.floor(progress * xs.length))];

/** m:ss without the unit (fmtPace carries its own "/km"). */
const mmss = (secPerKm: number) => fmtPace(secPerKm).replace("/km", "");
const band = (pace: number | null, fallback: string) =>
  pace != null ? `${mmss(pace - RUN_BAND)}-${mmss(pace + RUN_BAND)}/km` : fallback;

/** Longest continuous effort a coach would set, minutes, by intent. Beyond it the
 *  rest of the session is easy running, not more of the same. */
const CONTINUOUS_CAP_MIN = { tempo: 35, threshold: 25 };
/** Ceiling on total rep work, minutes. */
const REP_CAP_MIN = { threshold: 40, interval: 25, race: 45 };

function seg(phase: string, label: string, zone: PaceZone | null, amount: { km?: number; min?: number; metres?: number }, notes: string | null): SessionSegment {
  return {
    phase, label, pace_zone: zone,
    // Swims are counted in metres, so they keep metre precision.
    distance_km: amount.metres != null ? amount.metres / 1000 : amount.km != null ? r1(amount.km) : null,
    duration_min: amount.min != null ? Math.round(amount.min) : null,
    notes,
  };
}

// ── Running (distance-based) ──────────────────────────────────────────────────

function runSegments(km: number, phase: EnvelopeWeek["phase"], progress: number, nth: number, weekInPhase: number, a: Anchors, goalType: string): SessionSegment[] | null {
  let wu = half(clamp(km * 0.2, 1.5, 3));
  let cd = half(clamp(km * 0.15, 1, 2.5));
  if (km - wu - cd < 2) { wu = 1; cd = 1; }
  const main = r1(km - wu - cd);
  if (main < 1.5) return null;

  const easyPace = a.easy ?? 360;
  const jogKm = (sec: number) => r1(sec / easyPace);
  const tempoPace = a.threshold != null ? a.threshold + 12 : null;
  const strides = phase === "build" || phase === "peak" ? " with 4 strides at the end" : "";
  const warm = seg("warmup", "Warm-up", "zone2", { km: wu }, `Easy${a.easy != null ? `, ${mmss(a.easy)}/km or slower` : ""}${strides}.`);
  const kmIn = (minutes: number, pace: number | null) => minutes * 60 / (pace ?? 300);

  // Reps + recoveries, with whatever does not fit going to the cool-down.
  const reps = (repKm: number, recKm: number, recLabel: string, pace: number | null, zone: PaceZone, effort: string, label: (n: number) => string, capMin: number): SessionSegment[] | null => {
    const byTime = Math.floor(kmIn(capMin, pace) / repKm);
    const n = Math.min(byTime, Math.floor((main + recKm) / (repKm + recKm)));
    if (n < 2) return null;
    const work = r1(n * repKm);
    const rec = r1((n - 1) * recKm);
    return [
      warm,
      seg("main", label(n), zone, { km: work }, `${band(pace, effort)}.`),
      seg("recovery", "Recoveries", "zone1", { km: rec }, `${recLabel} between reps.`),
    ];
  };
  const continuous = (pace: number | null, zone: PaceZone, label: string, effort: string, share: number, capMin: number): SessionSegment[] => {
    const work = clamp(half(Math.min(main * share, kmIn(capMin, pace))), Math.min(2, main), main);
    return [warm, seg("main", `${r1(work)} km ${label}`, zone, { km: work }, `${band(pace, effort)}, continuous.`)];
  };

  let body: SessionSegment[] | null = null;
  const longEvent = LONG_EVENTS.has(goalType);
  const shortEvent = SHORT_EVENTS.has(goalType);

  if (phase === "taper") {
    // Short race-pace touches, fewer as race day nears.
    const pace = a.racePace ?? a.threshold;
    const rec = jogKm(120);
    let n = step([4, 3], progress);
    while (n > 2 && n + (n - 1) * rec > main) n--;
    if (n + (n - 1) * rec <= main) {
      body = [
        warm,
        seg("main", `${n} × 1 km at race pace`, "race_pace", { km: n }, `${band(pace, "race effort")}, full recovery.`),
        seg("recovery", "Recoveries", "zone1", { km: r1((n - 1) * rec) }, "2 min easy jog between reps."),
      ];
    }
  } else if (phase === "base") {
    // Base alternates a steady tempo with hill reps for mechanics.
    // A second base session takes whichever the first did not, never the same.
    const hillsFirst = weekInPhase % 2 === 1;
    if ((nth === 0) === hillsFirst) {
      // About 450 m per rep: 60 s up and the jog back down. The rest is easy.
      let n = Math.round(6 + 4 * progress);
      while (n > 4 && n * 0.45 > main) n--;
      body = [warm, seg("main", `${n} × 60 s uphill`, "zone4", { km: Math.min(main, n * 0.45) }, "Strong but controlled up a moderate hill, jog back down.")];
    } else {
      body = continuous(tempoPace, "zone3", "steady tempo", "steady, comfortably hard", 0.6 + 0.4 * progress, CONTINUOUS_CAP_MIN.tempo);
    }
  } else if (phase === "build" || (phase === "peak" && longEvent && a.racePace == null)) {
    if (nth === 0) {
      const rep = step([1, 1.5, 2], progress);
      const rec = step([90, 90, 120], progress);
      body = reps(rep, jogKm(rec), `${rec >= 120 ? "2 min" : "90 s"} easy jog`, a.threshold, "zone4", "threshold effort, about one-hour race pace", (n) => `${n} × ${rep} km at threshold`, REP_CAP_MIN.threshold);
    }
    body ??= continuous(a.threshold != null ? a.threshold + 6 : null, "zone3", "tempo", "comfortably hard", 0.7 + 0.3 * progress, CONTINUOUS_CAP_MIN.tempo);
  } else if (phase === "peak") {
    if (nth === 0 && longEvent && a.racePace != null) {
      // Longest block that still fits twice, from where the phase says to be.
      for (let block = step([3, 4, 5], progress); block >= 2 && !body; block--) {
        const b = block;
        body = reps(b, 1, "1 km easy", a.racePace, "race_pace", "goal race pace", (n) => `${n} × ${b} km at goal race pace`, REP_CAP_MIN.race);
      }
    } else if (nth === 0) {
      const rep = step([0.8, 1, 1.2], progress);
      body = reps(rep, r1(rep / 2), `${Math.round(rep * 500)} m jog`, a.interval, "zone5", "hard, about 3-5 km race effort", (n) => `${n} × ${Math.round(rep * 1000)} m`, REP_CAP_MIN.interval);
    } else if (shortEvent && a.racePace != null) {
      // The second peak session for a short race: race-pace repeats.
      const rep = step([1, 1.5], progress);
      body = reps(rep, jogKm(120), "2 min easy jog", a.racePace, "race_pace", "goal race pace", (n) => `${n} × ${rep} km at goal race pace`, REP_CAP_MIN.race);
    } else if (nth === 1) {
      // The second peak session otherwise holds threshold as cruise reps.
      const rep = step([1.5, 2], progress);
      body = reps(rep, jogKm(90), "90 s easy jog", a.threshold, "zone4", "threshold effort", (n) => `${n} × ${rep} km at threshold`, REP_CAP_MIN.threshold);
    }
    body ??= continuous(a.threshold, "zone4", "at threshold", "threshold effort", 0.6 + 0.3 * progress, CONTINUOUS_CAP_MIN.threshold);
  }
  if (!body) return null;

  // The cool-down absorbs every rounding remainder, so the total is exact.
  const used = body.reduce((s, x) => s + (x.distance_km ?? 0), 0);
  const rest = r1(km - used);
  if (rest <= 0) return null;
  return [...body, seg("cooldown", "Cool-down", "zone1", { km: rest }, "Easy.")];
}

// ── Cycling (duration-based) ──────────────────────────────────────────────────

function bikeSegments(min: number, phase: EnvelopeWeek["phase"], progress: number, nth: number, a: Anchors): SessionSegment[] | null {
  const wu = Math.round(clamp(min * 0.2, 10, 15));
  const cd = Math.round(clamp(min * 0.12, 5, 10));
  const main = min - wu - cd;
  if (main < 15) return null;
  const watts = (lo: number, hi: number, effort: string) => a.ftp != null ? `${Math.round(a.ftp * lo)}-${Math.round(a.ftp * hi)} W (${Math.round(lo * 100)}-${Math.round(hi * 100)}% FTP)` : effort;

  type Spec = { rep: number; rest: number; zone: PaceZone; label: string; target: string };
  let spec: Spec;
  if (phase === "taper") spec = { rep: 2, rest: 3, zone: "zone4", label: "openers", target: watts(1.0, 1.05, "race effort") };
  else if (phase === "base" || (phase === "build" && nth === 1)) spec = { rep: step([10, 15, 20], progress), rest: 5, zone: "zone3", label: "sweet spot", target: watts(0.88, 0.94, "steady and strong, a notch under threshold") };
  else if (phase === "build") spec = { rep: step([8, 12, 15], progress), rest: 5, zone: "zone4", label: "threshold", target: watts(0.95, 1.05, "hard but sustainable for about an hour") };
  else spec = { rep: step([3, 4, 5], progress), rest: step([3, 4, 5], progress), zone: "zone5", label: "VO2", target: watts(1.06, 1.2, "very hard, 3-8 minute effort") };

  const max = phase === "taper" ? 3 : 6;
  let n = Math.min(max, Math.floor((main + spec.rest) / (spec.rep + spec.rest)));
  if (n < 2) {
    // A short ride (a triathlete's midweek hour) still gets two reps, shorter.
    const shorter = Math.floor((main - spec.rest) / 2);
    if (shorter < (spec.zone === "zone5" ? 2 : 6)) return null;
    spec = { ...spec, rep: shorter };
    n = 2;
  }
  const work = n * spec.rep, rec = (n - 1) * spec.rest;
  const segs = [
    seg("warmup", "Warm-up", "zone2", { min: wu }, "Easy spinning, build gradually."),
    seg("main", `${n} × ${spec.rep} min ${spec.label}`, spec.zone, { min: work }, `${spec.target}.`),
    seg("recovery", "Recoveries", "zone1", { min: rec }, `${spec.rest} min easy between efforts.`),
  ];
  const rest = min - wu - work - rec;
  return [...segs, seg("cooldown", "Cool-down and endurance", "zone1", { min: rest }, "Easy.")];
}

// ── Swimming (metres when recorded, otherwise time) ──────────────────────────

function swimSegments(metres: number | null, min: number | null, phase: EnvelopeWeek["phase"], progress: number, a: Anchors): SessionSegment[] | null {
  const pace = (offset: number, effort: string) => a.css != null ? `${fmtSwimPace(a.css + offset - SWIM_BAND)}-${fmtSwimPace(a.css + offset + SWIM_BAND)}/100 m` : effort;

  if (metres == null) {
    if (min == null || min < 20) return null;
    const wu = 8, cd = 5, main = min - wu - cd;
    const rep = step([3, 4, 6], progress);
    const n = Math.floor((main + 0.5) / (rep + 0.5));
    if (n < 2) return null;
    const restMin = Math.round((n - 1) * 0.5);
    const cdMin = min - wu - n * rep - restMin;
    if (cdMin <= 0) return null;
    return [
      seg("warmup", "Warm-up", "zone2", { min: wu }, "Easy, mixed strokes."),
      seg("main", `${n} × ${rep} min`, a.weakSwimmer ? "zone2" : "zone4", { min: n * rep }, a.weakSwimmer ? "Smooth and long, focus on form." : "Strong, threshold effort."),
      seg("recovery", "Rest", "zone1", { min: restMin }, "30 s rest between."),
      seg("cooldown", "Cool-down", "zone1", { min: cdMin }, "Easy."),
    ];
  }

  const wu = metres >= 1500 ? 400 : 200;
  const cd = metres >= 1500 ? 200 : 100;
  const main = metres - wu - cd;
  if (main < 300) return null;

  type Spec = { rep: number; rest: number; zone: PaceZone; label: string; target: string };
  let spec: Spec;
  if (a.weakSwimmer) spec = { rep: step([50, 75, 100], progress), rest: 20, zone: "zone2", label: "drill / swim", target: "first half drill, second half smooth swim" };
  else if (phase === "taper") spec = { rep: 50, rest: 20, zone: "zone4", label: "sharp", target: pace(-3, "fast and relaxed") };
  else if (phase === "base") spec = { rep: step([200, 300, 400], progress), rest: 15, zone: "zone3", label: "aerobic", target: pace(8, "steady") };
  else if (phase === "build") spec = { rep: step([100, 200, 400], progress), rest: step([15, 20, 20], progress), zone: "zone4", label: "at CSS", target: pace(0, "threshold effort") };
  else spec = { rep: step([300, 400, 500], progress), rest: 20, zone: "zone4", label: "race pace", target: pace(3, "race effort") };

  // A long set of short reps reads better as fewer, longer ones.
  while (Math.floor(main / spec.rep) > 12 && spec.rep < 400) spec = { ...spec, rep: spec.rep * 2 };
  let n = Math.floor(main / spec.rep);
  if (n < 2) {
    const shorter = Math.floor(main / 2 / 25) * 25;
    if (shorter < 50) return null;
    spec = { ...spec, rep: shorter };
    n = 2;
  }
  const work = n * spec.rep;
  return [
    seg("warmup", `Warm-up ${wu} m`, "zone2", { metres: wu }, "Easy, mixed strokes."),
    seg("main", `${n} × ${spec.rep} m ${spec.label}`, spec.zone, { metres: work }, `${spec.target}, ${spec.rest} s rest.`),
    seg("cooldown", `Cool-down ${metres - wu - work} m`, "zone1", { metres: metres - wu - work }, "Easy."),
  ];
}

// ── The plan pass ─────────────────────────────────────────────────────────────

/**
 * Attach segments to every quality session. Run after expansion AND repair, so
 * the structure describes the session as stored. Mutates the plan.
 */
export function structurePlan(plan: GeneratedPlan, envelope: PlanEnvelope, profile: AthleteProfile, ctx: StructureContext): number {
  const anchors: Anchors = {
    easy: profile.run.easyPaceSecPerKm,
    threshold: profile.run.thresholdPaceSecPerKm,
    interval: profile.run.intervalPaceSecPerKm,
    racePace: ctx.racePaceSecPerKm,
    ftp: profile.bike.ftp.value,
    css: profile.swim.css.value,
    weakSwimmer: profile.experienceLevel === "beginner" || (profile.swim.css.value ?? 0) > 140 || !profile.swim.distanceRecorded,
  };

  // Where each week sits in its phase (deload weeks do not count), for progression.
  const position = new Map<number, { progress: number; index: number }>();
  for (const w of envelope.weeks) {
    if (w.isRecovery) continue;
    const same = envelope.weeks.filter((x) => !x.isRecovery && x.phase === w.phase);
    const index = same.indexOf(w);
    position.set(w.week_number, { index, progress: same.length > 1 ? index / (same.length - 1) : 0 });
  }

  let n = 0;
  for (const week of plan.weeks) {
    const env = envelope.weeks.find((w) => w.week_number === week.week_number);
    if (!env || env.isRecovery) continue;
    const pos = position.get(week.week_number) ?? { progress: 0, index: 0 };
    const nthBySport = new Map<SportKey, number>();
    for (const s of week.workouts) {
      if (!QUALITY.has(s.workout_type)) continue;
      const sport = (s.sport ?? "run") as SportKey;
      const nth = nthBySport.get(sport) ?? 0;
      nthBySport.set(sport, nth + 1);
      let segs: SessionSegment[] | null = null;
      if (sport === "run" && s.target_distance_km) {
        segs = runSegments(s.target_distance_km, env.phase, pos.progress, nth, pos.index, anchors, ctx.goalType);
      } else if (sport === "bike" && s.target_duration_min) {
        segs = bikeSegments(s.target_duration_min, env.phase, pos.progress, nth, anchors);
      } else if (sport === "swim") {
        const metres = s.target_distance_km ? Math.round(s.target_distance_km * 1000) : null;
        segs = swimSegments(metres, s.target_duration_min ?? null, env.phase, pos.progress, anchors);
      }
      if (segs && segs.length) { s.segments = segs; n++; }
    }
  }
  return n;
}

/** Total of a session's segments in its own unit, for the exact-sum check. */
export function segmentTotal(segs: SessionSegment[], unit: "km" | "m" | "min"): number {
  if (unit === "m") return Math.round(segs.reduce((s, x) => s + (x.distance_km ?? 0), 0) * 1000);
  return unit === "km"
    ? r1(segs.reduce((s, x) => s + (x.distance_km ?? 0), 0))
    : Math.round(segs.reduce((s, x) => s + (x.duration_min ?? 0), 0));
}

/** One compact line describing a session's structure, for the describe pass. */
export function structureLine(segs: SessionSegment[]): string {
  return segs.map((x) => {
    const amt = x.distance_km != null ? `${x.distance_km} km` : x.duration_min != null ? `${x.duration_min} min` : "";
    return `${x.label}${amt && !x.label.includes(" m ") ? ` (${amt})` : ""}${x.notes ? `: ${x.notes}` : ""}`;
  }).join(" | ");
}
