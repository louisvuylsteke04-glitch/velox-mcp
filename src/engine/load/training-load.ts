/**
 * Training load in TSS-like units. Ported from the Vēlox web app's
 * lib/training-load.ts, running only: the FTP, bike-power-zone and
 * bike/swim/strength branches are removed. Numbers for runs are unchanged.
 *
 * Runs: Banister TRIMP from heart-rate reserve when average HR is known (an
 * easy hour lands around 55-70, a threshold hour around 100), else the
 * ingest-time pace proxy (see run-features.ts), else RPE, else a flat default.
 */

export type LoadSport = "run";

/** Intensity factor per prescribed zone (fraction of threshold). */
export const ZONE_IF: Record<string, number> = {
  zone1: 0.55,
  zone2: 0.65,
  zone3: 0.75,
  zone4: 0.85,
  zone5: 0.95,
  race_pace: 1.0,
};

/** Fallback IF per workout type when a session carries no zone. */
const TYPE_IF: Record<string, number> = {
  recovery: 0.55,
  easy: 0.65,
  long_run: 0.7,
  tempo: 0.85,
  threshold: 0.88,
  interval: 0.92,
  race: 1.0,
  cross_train: 0.62,
  rest: 0,
};


// ── Actual load ───────────────────────────────────────────────────────────────

/**
 * Sex-specific Banister TRIMP weighting Y = a·e^(b·ΔHR). Vermeire/UGent (after
 * Banister): men a=0.64 b=1.92, women a=0.86 b=1.67. The female curve rises less
 * steeply, mirroring the sex difference in the lactate–HR response. Unknown sex
 * defaults to the male curve so existing athletes' numbers are unchanged.
 */
export function banisterCoeffs(sex?: string | null): { a: number; b: number } {
  return sex === "female" ? { a: 0.86, b: 1.67 } : { a: 0.64, b: 1.92 };
}

/** Normalise a stored gender string to "male" | "female" | null for the load model. */
export function normaliseSex(gender?: string | null): "male" | "female" | null {
  const g = (gender ?? "").trim().toLowerCase();
  if (g === "female" || g === "f" || g === "woman" || g === "w") return "female";
  if (g === "male" || g === "m" || g === "man") return "male";
  return null;
}

/** Default resting HR when the athlete has not set one. Shared across every load path. */
export const DEFAULT_REST_HR = 55;
/** Default max HR when neither a measured value nor a birth date is available. */
export const DEFAULT_MAX_HR = 190;

/** Banister TRIMP from HR reserve — the same formula the run sync uses. */
export function banisterTrimp(
  movingTimeMin: number,
  avgHr: number,
  maxHr: number | null,
  restHr: number | null,
  sex?: string | null,
): number {
  const max = maxHr && maxHr > 100 ? maxHr : DEFAULT_MAX_HR;
  const rest = restHr && restHr > 30 && restHr < max ? restHr : DEFAULT_REST_HR;
  if (avgHr <= rest) return 0;
  const ratio = Math.max(0, Math.min(1, (avgHr - rest) / (max - rest)));
  const { a, b } = banisterCoeffs(sex);
  return movingTimeMin * ratio * a * Math.exp(b * ratio);
}

export type LoadActivity = {
  moving_time_min: number | null;
  average_heartrate_bpm?: number | null;
  trimp?: number | null;
  // subjective: session RPE on the Borg CR10 scale (1-10), when the athlete logged it
  rpe?: number | null;
};

/**
 * Session RPE load (Foster's sRPE, arbitrary units) = duration(min) × RPE(1-10).
 * A parallel internal-load channel to the HR/power TSS: it captures mental fatigue,
 * heat and life stress that HR and power miss, and is validated for acute fatigue.
 * Kept as its own currency (not summed into TSS) so the two can be cross-checked.
 */
export function sessionRpeLoad(movingTimeMin: number | null, rpe: number | null): number | null {
  if (movingTimeMin == null || movingTimeMin <= 0) return null;
  if (rpe == null || rpe < 1 || rpe > 10) return null;
  return Math.round(movingTimeMin * rpe);
}

// ── RPE-derived load ──────────────────────────────────────────────────────────

/**
 * Load from RPE alone, for sessions with no power, HR or pace signal.
 *
 * Calibrated against the run pace proxy rather than the raw squared-IF scale.
 * The earlier version treated RPE/10 as an intensity factor, which put an
 * RPE-only session on the TSS scale (RPE 7 for 1 h ≈ 49) while the thing it
 * replaces sits on the much flatter pace-proxy scale (an easy hour ≈ 28). Wiring
 * that in would have stepped every affected athlete's CTL and ATL at the
 * changeover. See docs/LOAD_WITHOUT_HR.md.
 *
 * Two properties make the substitution continuous:
 *
 *  - The SHAPE is the pace proxy's own effort-factor range, 0.25 to 1.2 spread
 *    linearly across RPE 1-10, so RPE spans the same dynamic range that pace does.
 *  - The ANCHOR is each sport's existing no-data default, which the curve passes
 *    through exactly at RPE 4. An athlete who rates a session the way the current
 *    default already assumes sees no change at all; only unusually easy or hard
 *    sessions move, which is the entire point of asking for RPE.
 */
const RPE_EFFORT_FLOOR = 0.25;
const RPE_EFFORT_CAP = 1.2;
/** The RPE each sport's no-data default already implies: an easy aerobic session. */
const RPE_REFERENCE = 4;

function rpeEffortFactor(rpe: number): number {
  return RPE_EFFORT_FLOOR + ((rpe - 1) / 9) * (RPE_EFFORT_CAP - RPE_EFFORT_FLOOR);
}
const RPE_REFERENCE_FACTOR = rpeEffortFactor(RPE_REFERENCE);

/**
 * Per-hour load each sport falls back to when only duration is known. These are
 * the existing defaults, restated so the RPE curve can be anchored to them.
 *
 * `run` is the one that is not a local constant: it mirrors the ingest-time pace
 * proxy at its no-distance default pace, `60 × (300/360) × 0.55`
 * (`run-features.ts`, ported from the web app's lib/strava-sync.ts). If that formula changes, this must change with it.
 */
export const NO_DATA_LOAD_PER_HOUR = {
  runPaceProxy: 27.5,
  /** activityTss's catch-all branch: rows with no other signal. */
  other: 0.65 * 0.65 * 100,
} as const;

/**
 * Load for one session from RPE and duration, anchored to `baselinePerHour`.
 * Returns null for a missing or out-of-range RPE so callers fall through to the
 * flat default exactly as they did before.
 */
export function rpeLoad(hours: number, rpe: number | null | undefined, baselinePerHour: number): number | null {
  // Number.isFinite first: NaN fails every comparison, so a bare range check lets
  // it through and one NaN would poison a whole day's total and the EWMA after it.
  if (rpe == null || !Number.isFinite(rpe) || rpe < 1 || rpe > 10) return null;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.round(hours * baselinePerHour * (rpeEffortFactor(rpe) / RPE_REFERENCE_FACTOR));
}

export type LoadAthlete = {
  maxHr: number | null;
  restHr: number | null;
  /** "male" | "female" — picks the Banister curve. Unknown defaults to male. */
  sex?: string | null;
};

/** TSS-equivalent load for one completed activity. 0 for empty sessions. */
export function activityTss(a: LoadActivity, athlete: LoadAthlete): number {
  const mins = a.moving_time_min ?? 0;
  if (mins <= 0) return 0;
  const hours = mins / 60;
  // Stored TRIMP is the best signal.
  if (a.trimp != null && a.trimp > 0) return Math.round(a.trimp);
  if (a.average_heartrate_bpm != null && a.average_heartrate_bpm > 0) {
    return Math.round(banisterTrimp(mins, a.average_heartrate_bpm, athlete.maxHr, athlete.restHr, athlete.sex));
  }
  return rpeLoad(hours, a.rpe, NO_DATA_LOAD_PER_HOUR.other) ?? Math.round(hours * NO_DATA_LOAD_PER_HOUR.other);
}

// ── Planned load ──────────────────────────────────────────────────────────────

export type PlannedSessionForLoad = {
  sport?: LoadSport | null;
  workout_type: string;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_pace_zone?: string | null;
};

export type PlannedLoadCtx = {
  /** Athlete run paces (sec/km) for converting run distance to duration. */
  easyPaceSecPerKm?: number | null;
  thresholdPaceSecPerKm?: number | null;
};

const FALLBACK_EASY_PACE = 360;      // 6:00/km
const FALLBACK_THRESHOLD_PACE = 285; // 4:45/km

/**
 * Deterministic TSS estimate for a planned session. Duration comes from
 * target_duration_min, or for runs from distance x the zone-appropriate pace.
 * Computed on read; never stored, so it can never go stale.
 */
export function estimatePlannedLoad(s: PlannedSessionForLoad, ctx: PlannedLoadCtx = {}): number {
  if (s.workout_type === "rest") return 0;
  const sport = (s.sport ?? "run") as LoadSport;
  const intensity = (s.target_pace_zone && ZONE_IF[s.target_pace_zone] != null)
    ? ZONE_IF[s.target_pace_zone]
    : (TYPE_IF[s.workout_type] ?? 0.65);
  if (intensity <= 0) return 0;

  let hours: number | null = null;
  const km = s.target_distance_km != null && s.target_distance_km > 0 ? s.target_distance_km : null;
  if (s.target_duration_min != null && s.target_duration_min > 0) {
    hours = s.target_duration_min / 60;
  } else if (km != null && sport === "run") {
    const easy = ctx.easyPaceSecPerKm ?? FALLBACK_EASY_PACE;
    const thr = ctx.thresholdPaceSecPerKm ?? FALLBACK_THRESHOLD_PACE;
    // Zone 1-2 (and easy/long/recovery types) run at easy pace; zone 4 and up at
    // threshold pace; zone 3 blends between them.
    const pace = intensity <= 0.7 ? easy : intensity >= 0.85 ? thr : (easy + thr) / 2;
    hours = (km * pace) / 3600;
  }
  if (hours == null || hours <= 0) return 0;
  return Math.round(hours * intensity * intensity * 100);
}

