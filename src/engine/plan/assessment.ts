/**
 * Week 1 as an assessment week (#121, C5, ASSESSMENT_WEEK).
 *
 * A coach's first week with a new athlete is not the first step of a ramp. It
 * holds the volume they already run, keeps the intensity down, and measures what
 * the plan has had to guess. So for an athlete new to Velox, on their first plan:
 *
 *   - week 1 keeps every distance and duration the engine set;
 *   - its quality sessions become easy, except one benchmark where an anchor is
 *     missing, placed in the week's first quality slot for that sport:
 *       run   a 5 km time trial (3 km when the slot is shorter), when run paces
 *             rest on easy-pace ratios or on nothing;
 *       swim  a CSS test (400 m then 200 m, both all-out), when swims record
 *             distance but CSS is unknown;
 *       bike  never: FTP is estimated whenever rides carry power, and without a
 *             power meter no test can produce one.
 *
 * A benchmark is marked by a segment with phase "benchmark". Segments survive a
 * move to another day and are cleared when an edit changes the session's shape
 * (STRUCTURED_SESSIONS), which is exactly when it stops being a benchmark. The
 * DB constraint on workout_type leaves no room for a "test" type.
 */

import type { GeneratedPlan, GeneratedSession, SessionSegment } from "../types/calendar";
import type { AthleteProfile } from "./profile";
import type { PlanEnvelope } from "./types";

export const BENCHMARK_PHASE = "benchmark";
const QUALITY = new Set(["tempo", "threshold", "interval"]);
const r1 = (n: number) => Math.round(n * 10) / 10;

export type AssessmentResult = { run: number | null; swim: boolean };

function seg(phase: string, label: string, zone: SessionSegment["pace_zone"], km: number | null, notes: string): SessionSegment {
  return { phase, label, pace_zone: zone, distance_km: km, duration_min: null, notes };
}

/** A run time trial that fits inside `km`, or null when even 3 km does not. */
export function runBenchmark(km: number): { ttKm: number; segments: SessionSegment[] } | null {
  for (const [ttKm, wu] of [[5, 2], [3, 1.5]] as const) {
    const cd = r1(km - wu - ttKm);
    if (cd < 1) continue;
    return {
      ttKm,
      segments: [
        seg("warmup", "Warm-up", "zone2", wu, "Easy, then 4 strides to wake the legs up."),
        seg(BENCHMARK_PHASE, `${ttKm} km time trial`, "zone5", ttKm, "An even, hard race effort from the start. Your time sets your training paces."),
        seg("cooldown", "Cool-down", "zone1", cd, "Easy."),
      ],
    };
  }
  return null;
}

/** A CSS test that fits inside `metres`, or null below 1400 m. */
export function swimBenchmark(metres: number): SessionSegment[] | null {
  const cd = metres - 400 - 400 - 200 - 200;
  if (cd < 200) return null;
  const m = (x: number) => x / 1000;
  return [
    seg("warmup", "Warm-up 400 m", "zone2", m(400), "Easy, mixed strokes."),
    seg(BENCHMARK_PHASE, "400 m all-out", "zone5", m(400), "As fast as you can hold for the whole 400 m. Note your time."),
    seg("recovery", "200 m easy", "zone1", m(200), "Easy, until your breathing settles."),
    seg(BENCHMARK_PHASE, "200 m all-out", "zone5", m(200), "As fast as you can hold. Note your time."),
    seg("cooldown", `Cool-down ${cd} m`, "zone1", m(cd), "Easy."),
  ];
}

function makeEasy(s: GeneratedSession): void {
  s.workout_type = "easy";
  s.target_pace_zone = "zone2";
  s.title = "";
  s.segments = null;
  s.coach_cue = null;
}

/**
 * Turn week 1 into an assessment week. Mutates the plan; never changes a
 * distance or a duration. Returns which benchmarks were placed.
 */
export function applyAssessmentWeek(plan: GeneratedPlan, envelope: PlanEnvelope, profile: AthleteProfile): AssessmentResult {
  const result: AssessmentResult = { run: null, swim: false };
  const week = plan.weeks.find((w) => w.week_number === 1);
  if (!week) return result;

  const runAnchorMissing = envelope.roles.run !== "off"
    && (!profile.run.paceAnchor || profile.run.paceAnchor.source === "easy_ratio");
  const swimAnchorMissing = envelope.roles.swim !== "off" && profile.swim.distanceRecorded && profile.swim.css.value == null;

  for (const s of week.workouts) {
    if (!QUALITY.has(s.workout_type)) continue;
    const sport = s.sport ?? "run";

    if (sport === "run" && runAnchorMissing && result.run == null && s.target_distance_km) {
      const b = runBenchmark(s.target_distance_km);
      if (b) {
        s.workout_type = "threshold";
        s.target_pace_zone = "zone5";
        s.title = `${b.ttKm} km time trial`;
        s.segments = b.segments;
        s.coach_cue = "Assessment week. This time trial sets your training paces, so run it as an even, hard race effort.";
        result.run = b.ttKm;
        continue;
      }
    }
    if (sport === "swim" && swimAnchorMissing && !result.swim && s.target_distance_km) {
      const segs = swimBenchmark(Math.round(s.target_distance_km * 1000));
      if (segs) {
        s.workout_type = "threshold";
        s.target_pace_zone = "zone5";
        s.title = "CSS test";
        s.segments = segs;
        s.coach_cue = "Assessment week. Your 400 m and 200 m times set your swim threshold pace.";
        result.swim = true;
        continue;
      }
    }
    makeEasy(s);
  }
  return result;
}

/**
 * The time-trial time inside a run, from its per-km splits: the fastest run of
 * `ttKm` consecutive kilometres. Null when the splits cannot cover it.
 */
export function benchmarkSecondsFromSplits(splits: unknown, ttKm: number): number | null {
  if (!Array.isArray(splits) || ttKm < 1) return null;
  const paces = splits.map((s) => Number((s as { pace_sec_per_km?: unknown }).pace_sec_per_km));
  if (paces.length < ttKm) return null;
  let best: number | null = null;
  for (let i = 0; i + ttKm <= paces.length; i++) {
    const window = paces.slice(i, i + ttKm);
    if (window.some((p) => !Number.isFinite(p) || p <= 0)) continue;
    const total = window.reduce((a, b) => a + b, 0);
    if (best == null || total < best) best = total;
  }
  return best != null ? Math.round(best) : null;
}

/** The trial distance a benchmark session was built for, from its segments. */
export function benchmarkKm(segments: unknown): number | null {
  if (!Array.isArray(segments)) return null;
  const b = segments.find((s) => (s as { phase?: string }).phase === BENCHMARK_PHASE) as { distance_km?: number } | undefined;
  return b?.distance_km ?? null;
}
