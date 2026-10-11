export type WorkoutType =
  | "easy" | "long_run" | "tempo" | "interval" | "threshold"
  | "recovery" | "race" | "cross_train" | "rest";

export type PaceZone =
  | "zone1" | "zone2" | "zone3" | "zone4" | "zone5" | "race_pace";

export type WorkoutStatus =
  | "planned" | "completed" | "skipped" | "modified" | "suggested_change";

export type PlanStatus = "active" | "archived" | "superseded";

/** Volume + phase for a single plan week, used for far weeks that have no
 *  day-by-day rows yet. Stored on training_plans.week_targets. */
export type PlanWeekTarget = {
  week_number: number;
  phase: string;
  target_weekly_km: number;
  /** Planned long-run cap (km) for the week — shown in the far-week summary. */
  long_run_cap_km?: number;
  /** Cross-sport weekly targets (bike/swim/triathlon goals). */
  bike_hours?: number | null;
  long_ride_hours?: number | null;
  swim_km?: number | null;
};

export type TrainingPlan = {
  id: number;
  athlete_id: number;
  athlete_goal_id: number | null;
  status: PlanStatus;
  plan_start_date: string;   // YYYY-MM-DD
  plan_end_date: string;     // YYYY-MM-DD
  total_weeks: number;
  generation_model: string | null;
  plan_notes: string | null;
  // Far-week volume plan: every week's phase + target km. Near weeks also have
  // day-by-day planned_workouts rows; far weeks live only here until materialised.
  week_targets?: PlanWeekTarget[] | null;
  created_at: string;
  updated_at: string;
};

/** A single block inside a structured session (warmup, main, cooldown, etc). */
export type SessionSegment = {
  phase: "warmup" | "main" | "cooldown" | "interval" | "recovery" | "rest" | string;
  label: string;
  distance_km: number | null;
  pace_zone: PaceZone | null;
  duration_min: number | null;
  notes: string | null;
};

export type PlannedWorkout = {
  id: number;
  training_plan_id: number;
  athlete_id: number;
  scheduled_date: string;    // YYYY-MM-DD
  week_number: number;
  title: string;
  workout_type: WorkoutType;
  /** Discipline. Legacy rows default to "run" (DB default). */
  sport?: SessionSport;
  description: string | null;
  target_distance_km: number | null;
  target_duration_min: number | null;
  target_pace_zone: PaceZone | null;
  target_pace_min_sec_per_km: number | null;
  target_pace_max_sec_per_km: number | null;
  status: WorkoutStatus;
  matched_strava_activity_id: number | null;
  matched_at: string | null;
  match_confidence: "auto" | "manual" | null;
  sort_order: number;
  // Phase 4: athlete feedback
  rpe: number | null;                  // 1–10
  fatigue_rating: number | null;       // 1–5
  athlete_notes: string | null;
  // Phase 5 (skeleton + slice): execution detail. detail_level === "summary"
  // means the session has only the structural fields (title, type, distance,
  // zone); segments and mental_cue are null until the slice is generated.
  // Optional in the type so demo fixtures and older DB rows that pre-date the
  // migration don't need to be updated en masse — readers default-treat
  // missing detail_level as 'full' (legacy data) when rendering.
  detail_level?: "full" | "summary";
  segments?: SessionSegment[] | null;
  mental_cue?: string | null;
  // Pinning: a session the athlete set themselves ("athlete") or the goal race
  // ("system"). Pinned sessions are never edited, moved, or deleted by the coach.
  // Optional so demo fixtures and rows pre-dating the migration need no changes.
  pinned_by?: "athlete" | "system" | null;
  pinned_at?: string | null;
  // Authored snapshot (#86 E2): the session as the plan generator wrote it,
  // written once and immutable after (DB trigger). NULL reads as "authored =
  // current". adapt_edit_count/last_adapted_at track accepted coach adaptations.
  // Optional for the same fixture/legacy reasons as pinning.
  authored_distance_km?: number | null;
  authored_duration_min?: number | null;
  authored_pace_zone?: PaceZone | null;
  adapt_edit_count?: number;
  last_adapted_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type PlanWithWorkouts = TrainingPlan & {
  workouts: PlannedWorkout[];
};

// Shape the AI must return for a single generated session
export type SessionSport = "run" | "bike" | "swim" | "strength";

export type GeneratedSession = {
  day_of_week: number;           // 1=Mon … 7=Sun
  title: string;
  workout_type: WorkoutType;
  /** Discipline of the session. Omitted/legacy sessions are runs. */
  sport?: SessionSport;
  /** Bike/swim sessions are usually prescribed by duration, not distance. */
  target_duration_min?: number | null;
  // Skeleton no longer emits per-session description; the slice generator
  // fills it in for the next 14 days. Keep the field as an optional input
  // for backwards compatibility with older outputs and tests.
  description?: string;
  target_distance_km: number | null;
  target_pace_zone: PaceZone | null;
  /** The coach's phase guidance for this session (#121, COACH_GUIDANCE).
   *  Stored in planned_workouts.mental_cue. See lib/plan/guidance.ts. */
  coach_cue?: string | null;
  /** Warm-up, main set and cool-down for a quality session (#121,
   *  STRUCTURED_SESSIONS). Stored in planned_workouts.segments. */
  segments?: SessionSegment[] | null;
};

export type GeneratedWeek = {
  week_number: number;
  phase: "base" | "build" | "peak" | "taper" | "recovery";
  target_weekly_km: number;
  workouts: GeneratedSession[];
};

export type GeneratedPlan = {
  plan_notes: string;
  weeks: GeneratedWeek[];
};
