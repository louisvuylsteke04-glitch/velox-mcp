/**
 * Training preferences — captured at onboarding, editable in Settings, and
 * surfaced as a summary at plan-generation time. The plan generator uses these
 * to honour preferred days, the long-run day, the minimum session distance,
 * and to only program cross-training / strength when the athlete has opted in.
 *
 * Stored as a JSONB blob on `athletes.training_preferences`. This module is
 * the single source of truth for the shape and validation.
 */

export type CrossType = "bike" | "swim" | "elliptical" | "other";

/** The sport the Analytics side-nav button lands on. All sport tabs are always
 *  visible in the on-page toggle; this only sets the default landing dashboard.
 *  "all" lands on the combined overall dashboard. */
export type MainSport = "run" | "bike" | "swim" | "all";

export type AnalyticsPreferences = {
  main_sport: MainSport;
};

const MAIN_SPORTS: readonly MainSport[] = ["run", "bike", "swim", "all"];

export type TrainingPreferences = {
  available_days:   number;          // 3..7
  preferred_days:   number[];        // ISO weekday 1=Mon .. 7=Sun, deduplicated
  long_run_day:     number;          // 1..7
  min_session_km:   number;          // >= 1, defaults to 5
  /** Hard cap on how long a single weekday session can be (minutes). null = no cap.
   *  Used to keep prescribed sessions inside the athlete's real daily time budget. */
  max_session_minutes: number | null;
  cross_training:   { willing: boolean; types: CrossType[] };
  strength_training:{ willing: boolean; weekly_count: number | null };
  plan_start_date_override: string | null; // YYYY-MM-DD, optional
  notes:            string;          // free-form, <= 300 chars
  /** Analytics visibility. Optional: absent until the athlete edits it in Settings. */
  analytics?:       AnalyticsPreferences;
  /** Current training volume in the athlete's own sport. Optional: absent for
   *  athletes who onboarded before the sport-aware step existed.
   *
   *  Deliberately sport-native rather than normalised to km. A cyclist thinks in
   *  hours and a swimmer in metres per session, and forcing either into running
   *  units would lose the meaning before the coach ever sees it. These feed the
   *  LLM coach through formatPreferencesForPrompt; the deterministic weekly load
   *  curve is still km-based and is not driven by them. */
  sport_volume?:    SportVolume;
};

export type SportVolume = {
  run_weekly_km?:          number | null;
  bike_weekly_hours?:      number | null;
  bike_longest_ride_km?:   number | null;
  swim_sessions_per_week?: number | null;
  swim_session_metres?:    number | null;
  tri_swim_sessions?:      number | null;
  tri_bike_sessions?:      number | null;
  tri_run_sessions?:       number | null;
};

const SPORT_VOLUME_FIELDS: (keyof SportVolume)[] = [
  "run_weekly_km", "bike_weekly_hours", "bike_longest_ride_km",
  "swim_sessions_per_week", "swim_session_metres",
  "tri_swim_sessions", "tri_bike_sessions", "tri_run_sessions",
];

/** Accepts only finite, non-negative numbers; anything else is dropped rather
 *  than coerced, so a bad value never reaches the coach as a confident figure. */
function normaliseSportVolume(raw: unknown): SportVolume | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const out: SportVolume = {};
  let any = false;
  for (const key of SPORT_VOLUME_FIELDS) {
    const v = src[key];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 0) { out[key] = n; any = true; }
  }
  return any ? out : undefined;
}

export const DEFAULT_PREFERENCES: TrainingPreferences = {
  available_days:   5,
  preferred_days:   [1, 3, 5, 6, 7],    // Mon, Wed, Fri, Sat, Sun
  long_run_day:     6,                  // Saturday
  min_session_km:   5,
  max_session_minutes: null,
  cross_training:   { willing: false, types: [] },
  strength_training:{ willing: false, weekly_count: null },
  plan_start_date_override: null,
  notes:            "",
};

const CROSS_TYPES: readonly CrossType[] = ["bike", "swim", "elliptical", "other"];

function isWeekday(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 7;
}

/**
 * Validate and normalise an inbound preferences object. Returns the normalised
 * shape on success or a list of validation errors on failure. Permissive on
 * shape (missing fields fall back to defaults) but strict on the values it
 * does accept so the column never holds something the reader can't trust.
 */
export function normaliseTrainingPreferences(
  input: unknown,
): { ok: true; value: TrainingPreferences } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (input === null) return { ok: true, value: DEFAULT_PREFERENCES };
  if (typeof input !== "object") {
    return { ok: false, errors: ["training_preferences must be an object or null"] };
  }
  const raw = input as Record<string, unknown>;

  // available_days
  let availableDays = DEFAULT_PREFERENCES.available_days;
  if ("available_days" in raw) {
    const v = raw.available_days;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 7) {
      availableDays = v;
    } else {
      errors.push("available_days must be an integer 1..7");
    }
  }

  // preferred_days
  let preferredDays = DEFAULT_PREFERENCES.preferred_days.slice();
  if ("preferred_days" in raw) {
    const v = raw.preferred_days;
    if (!Array.isArray(v) || !v.every(isWeekday)) {
      errors.push("preferred_days must be an array of integers 1..7");
    } else {
      preferredDays = Array.from(new Set(v as number[])).sort((a, b) => a - b);
    }
  }

  // long_run_day
  let longRunDay = DEFAULT_PREFERENCES.long_run_day;
  if ("long_run_day" in raw) {
    const v = raw.long_run_day;
    if (!isWeekday(v)) {
      errors.push("long_run_day must be an integer 1..7");
    } else {
      longRunDay = v;
    }
  }

  // min_session_km
  let minSessionKm = DEFAULT_PREFERENCES.min_session_km;
  if ("min_session_km" in raw) {
    const v = raw.min_session_km;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 50) {
      errors.push("min_session_km must be a number 1..50");
    } else {
      minSessionKm = Math.round(v * 10) / 10;
    }
  }

  // max_session_minutes (optional daily time cap)
  let maxSessionMinutes: number | null = DEFAULT_PREFERENCES.max_session_minutes;
  if ("max_session_minutes" in raw) {
    const v = raw.max_session_minutes;
    if (v === null || v === "") {
      maxSessionMinutes = null;
    } else if (typeof v === "number" && Number.isFinite(v) && v >= 20 && v <= 360) {
      maxSessionMinutes = Math.round(v);
    } else {
      errors.push("max_session_minutes must be a number 20..360 or null");
    }
  }

  // cross_training
  let cross = { ...DEFAULT_PREFERENCES.cross_training };
  if ("cross_training" in raw) {
    const v = raw.cross_training;
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const willing = obj.willing === true;
      let types: CrossType[] = [];
      if (Array.isArray(obj.types)) {
        types = obj.types.filter((t): t is CrossType => CROSS_TYPES.includes(t as CrossType));
      }
      cross = { willing, types: willing ? types : [] };
    } else {
      errors.push("cross_training must be an object");
    }
  }

  // strength_training
  let strength = { ...DEFAULT_PREFERENCES.strength_training };
  if ("strength_training" in raw) {
    const v = raw.strength_training;
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const willing = obj.willing === true;
      let weekly: number | null = null;
      if (willing && typeof obj.weekly_count === "number" && Number.isInteger(obj.weekly_count) && obj.weekly_count >= 1 && obj.weekly_count <= 5) {
        weekly = obj.weekly_count;
      }
      strength = { willing, weekly_count: weekly };
    } else {
      errors.push("strength_training must be an object");
    }
  }

  // plan_start_date_override
  let planStart: string | null = null;
  if ("plan_start_date_override" in raw) {
    const v = raw.plan_start_date_override;
    if (v === null || v === "") {
      planStart = null;
    } else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      planStart = v;
    } else {
      errors.push("plan_start_date_override must be a YYYY-MM-DD string or null");
    }
  }

  // notes
  let notes = DEFAULT_PREFERENCES.notes;
  if ("notes" in raw) {
    const v = raw.notes;
    if (typeof v !== "string") {
      errors.push("notes must be a string");
    } else {
      notes = v.slice(0, 300);
    }
  }

  // analytics (optional): which sport the Analytics nav lands on. Absent stays
  // absent so callers fall back to the default (running).
  const sportVolume = normaliseSportVolume(raw.sport_volume);

  let analytics: AnalyticsPreferences | undefined;
  if ("analytics" in raw && raw.analytics != null) {
    const v = raw.analytics;
    if (typeof v !== "object") {
      errors.push("analytics must be an object");
    } else {
      const obj = v as Record<string, unknown>;
      const main = MAIN_SPORTS.includes(obj.main_sport as MainSport) ? (obj.main_sport as MainSport) : "run";
      analytics = { main_sport: main };
    }
  }

  // The long-run day must be one of the preferred running days. If it isn't
  // (e.g. a preferred day was later removed), snap it to the first preferred day
  // so the plan generator never schedules the long run on a non-training day.
  if (preferredDays.length > 0 && !preferredDays.includes(longRunDay)) {
    longRunDay = preferredDays[0];
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      available_days:           availableDays,
      preferred_days:           preferredDays,
      long_run_day:             longRunDay,
      min_session_km:           minSessionKm,
      max_session_minutes:      maxSessionMinutes,
      cross_training:           cross,
      strength_training:        strength,
      plan_start_date_override: planStart,
      notes,
      ...(analytics ? { analytics } : {}),
      ...(sportVolume ? { sport_volume: sportVolume } : {}),
    },
  };
}

/** Read raw column data and return either a valid TrainingPreferences object
 *  or DEFAULT_PREFERENCES. Use this in any callsite that needs to consume
 *  the column — never trust the raw JSONB directly. */
export function readTrainingPreferences(raw: unknown): TrainingPreferences {
  const result = normaliseTrainingPreferences(raw);
  if (result.ok) return result.value;
  return DEFAULT_PREFERENCES;
}

const DAY_NAMES: readonly string[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One-line human summary for the Generate-plan modal. */
export function summariseTrainingPreferences(prefs: TrainingPreferences): string {
  const days = prefs.preferred_days.map((d) => DAY_NAMES[d - 1]).join(" · ") || "no preferred days";
  const longRun = `long run ${DAY_NAMES[prefs.long_run_day - 1]}`;
  const minKm = `${prefs.min_session_km} km min`;
  const cross = prefs.cross_training.willing
    ? `cross: ${prefs.cross_training.types.join(", ") || "any"}`
    : "no cross-training";
  const strength = prefs.strength_training.willing
    ? `strength${prefs.strength_training.weekly_count ? ` ${prefs.strength_training.weekly_count}x/week` : ""}`
    : "no strength";
  return [days, longRun, minKm, cross, strength].join(" · ");
}

/** Full structured block to inject into the plan-generation prompt. */
export function formatPreferencesForPrompt(prefs: TrainingPreferences): string {
  const lines: string[] = [];
  lines.push(`Runs per week: ${prefs.available_days}`);
  lines.push(`Preferred running days (ISO weekday 1=Mon..7=Sun): ${prefs.preferred_days.join(", ")}`);
  lines.push(`Preferred long-run day: ${prefs.long_run_day} (${DAY_NAMES[prefs.long_run_day - 1]})`);
  lines.push(`Minimum session distance: ${prefs.min_session_km} km`);
  if (prefs.max_session_minutes != null) {
    lines.push(`Preferred weekday session cap: about ${prefs.max_session_minutes} min — keep weekday runs near or under this where it does not compromise the session; the long run on the preferred long-run day is exempt.`);
  }
  lines.push(`Cross-training willing: ${prefs.cross_training.willing}${prefs.cross_training.willing && prefs.cross_training.types.length ? ` (${prefs.cross_training.types.join(", ")})` : ""}`);
  lines.push(`Strength training willing: ${prefs.strength_training.willing}${prefs.strength_training.willing && prefs.strength_training.weekly_count ? ` (${prefs.strength_training.weekly_count}x/week)` : ""}`);
  const v = prefs.sport_volume;
  if (v) {
    const vol: string[] = [];
    if (v.run_weekly_km != null)          vol.push(`current running volume about ${v.run_weekly_km} km/week`);
    if (v.bike_weekly_hours != null)      vol.push(`current riding volume about ${v.bike_weekly_hours} h/week`);
    if (v.bike_longest_ride_km != null)   vol.push(`longest recent ride about ${v.bike_longest_ride_km} km`);
    if (v.swim_sessions_per_week != null) vol.push(`swims about ${v.swim_sessions_per_week}x/week`);
    if (v.swim_session_metres != null)    vol.push(`typical swim session about ${v.swim_session_metres} m`);
    if (v.tri_swim_sessions != null)      vol.push(`triathlon swim ${v.tri_swim_sessions}x/week`);
    if (v.tri_bike_sessions != null)      vol.push(`triathlon bike ${v.tri_bike_sessions}x/week`);
    if (v.tri_run_sessions != null)       vol.push(`triathlon run ${v.tri_run_sessions}x/week`);
    if (vol.length) {
      lines.push(`Self-reported starting volume: ${vol.join("; ")}. Treat this as the athlete's own estimate of where they are now, and prefer their synced activity history where the two disagree.`);
    }
  }
  if (prefs.notes.trim()) lines.push(`Athlete notes: ${prefs.notes}`);
  return lines.join("\n");
}
