/**
 * Plan-engine fixtures shared by the golden generator (original web-app code)
 * and the parity tests (the port). Personas follow the web app's
 * scripts/engine-tests.ts. No real athlete data.
 */
import type { AthleteProfile } from "../../src/engine/plan/profile";
import { DEFAULT_PREFERENCES, type TrainingPreferences } from "../../src/engine/training-preferences";

export const PLAN_TODAY = "2026-10-11";

function profile(over: Partial<AthleteProfile> & { name: string }): AthleteProfile {
  const base: AthleteProfile = {
    athleteId: 1, name: over.name, firstName: over.name.split(" ")[0],
    ageYears: 35, sex: "male", weightKg: 72, experienceLevel: "intermediate",
    maxHr: 190, restHr: 55, hrZoneMaxPcts: null,
    run: { hasData: false, sessions4w: 0, weeklyKm: 0, weeklyKmHistory: [], longestKm: 0, daysSinceLast: null, easyPaceSecPerKm: 330, thresholdPaceSecPerKm: 290, intervalPaceSecPerKm: 270 },
    bike: { hasData: false, hasPower: false, sessions4w: 0, weeklyHours: 0, longestRideHours: 0, avgSpeedKmh: null, daysSinceLast: null, ftp: { value: null, source: null, basis: null } },
    swim: { hasData: false, distanceRecorded: false, sessions4w: 0, weeklyMetres: 0, weeklyHours: 0, longestSwimM: 0, daysSinceLast: null, css: { value: null, source: null, basis: null } },
    weekly: [],
    load: { ctl: 0, atl: 0, tsb: 0, formLabel: "Neutral", formColor: "", rampPct: null, monotony: null, strain: null, runSharePct: null, runShare7Pct: null, weekLoad7: { run: 0, bike: 0, swim: 0, total: 0 }, hasData: false },
    mechanicalRampPct: null,
    injury: { active: false, region: null, lowerLimb: false, summary: null, history: [], restrictions: { noHighImpactIntervals: false, noHillsPlyo: false, noDownhill: false, noSprintStrides: false, impactOff: false } },
    medical: { raised: false, reasons: [] },
    missedTraining: { action: "continue", volumeFactor: 1, note: "" },
    recentHighFatigue: false,
    prefs: { ...DEFAULT_PREFERENCES },
  };
  return { ...base, ...over };
}
const prefs = (over: Partial<TrainingPreferences> = {}): TrainingPreferences => ({ ...DEFAULT_PREFERENCES, ...over });

const RUNNER = profile({
  name: "Club runner",
  run: { hasData: true, sessions4w: 16, weeklyKm: 45, weeklyKmHistory: [40, 42, 45, 44, 46, 45, 47, 45], longestKm: 18, daysSinceLast: 1, easyPaceSecPerKm: 320, thresholdPaceSecPerKm: 280, intervalPaceSecPerKm: 260 },
  load: { ctl: 55, atl: 58, tsb: -3, formLabel: "Neutral", formColor: "", rampPct: 3, monotony: 1.2, strain: 500, runSharePct: 100, runShare7Pct: 100, weekLoad7: { run: 420, bike: 0, swim: 0, total: 420 }, hasData: true },
});

const BEGINNER = profile({
  name: "New runner", experienceLevel: "beginner", ageYears: 29,
  run: { hasData: true, sessions4w: 6, weeklyKm: 12, weeklyKmHistory: [6, 8, 10, 9, 11, 12, 12, 13], longestKm: 6, daysSinceLast: 2, easyPaceSecPerKm: 410, thresholdPaceSecPerKm: 355, intervalPaceSecPerKm: 335 },
  prefs: prefs({ available_days: 4, preferred_days: [2, 4, 6, 7], long_run_day: 7, max_session_minutes: 60 }),
  load: { ctl: 15, atl: 17, tsb: -2, formLabel: "Neutral", formColor: "", rampPct: 6, monotony: 0.9, strain: 110, runSharePct: 100, runShare7Pct: 100, weekLoad7: { run: 110, bike: 0, swim: 0, total: 110 }, hasData: true },
});

const NO_HISTORY = profile({
  name: "Fresh start", experienceLevel: "beginner",
  prefs: prefs({ sport_volume: { run_weekly_km: 15 } } as Partial<TrainingPreferences>),
});

const INJURED_MASTERS = profile({
  name: "Masters runner, injured", ageYears: 56,
  run: { hasData: true, sessions4w: 10, weeklyKm: 32, weeklyKmHistory: [36, 35, 34, 30, 32, 31, 33, 32], longestKm: 15, daysSinceLast: 3, easyPaceSecPerKm: 350, thresholdPaceSecPerKm: 305, intervalPaceSecPerKm: 285 },
  injury: { active: true, region: "Achilles/calf/foot", lowerLimb: true, summary: "Achilles tightness", history: ["plantar fasciitis 2024"], restrictions: { noHighImpactIntervals: true, noHillsPlyo: true, noDownhill: false, noSprintStrides: true, impactOff: false } },
  recentHighFatigue: true,
  load: { ctl: 40, atl: 44, tsb: -4, formLabel: "Neutral", formColor: "", rampPct: 2, monotony: 1.1, strain: 320, runSharePct: 100, runShare7Pct: 100, weekLoad7: { run: 300, bike: 0, swim: 0, total: 300 }, hasData: true },
});

const RETURNING = profile({
  ...RUNNER, name: "Returning runner",
  run: { ...RUNNER.run, daysSinceLast: 18, sessions4w: 2, weeklyKm: 8 },
  missedTraining: { action: "base_week", volumeFactor: 0.65, note: "18 days off" },
});

/** A coach-written blueprint in the shape the web app's LLM returned. */
export const COACH_BLUEPRINT = {
  coach_analysis: "Strong aerobic base, threshold is the limiter. Build tempo volume, protect the long run.",
  plan_notes: "Fourteen weeks to Valencia half. Threshold first, then race-specific work.",
  phases: [
    { from_week: 1, to_week: 5, template: [{ day: 7, sport: "run", kind: "long" }, { day: 2, sport: "run", kind: "quality" }, { day: 4, sport: "run", kind: "quality" }, { day: 1, sport: "run", kind: "recovery" }, { day: 5, sport: "run", kind: "easy" }],
      quality: { run: "cruise intervals at threshold, 3x10 min building to 3x15 min" }, long_texture: { run: "easy, last 3 km steady" } },
    { from_week: 6, to_week: 11, template: [{ day: 7, sport: "run", kind: "long" }, { day: 2, sport: "run", kind: "quality" }, { day: 4, sport: "run", kind: "quality" }, { day: 1, sport: "run", kind: "recovery" }, { day: 5, sport: "run", kind: "easy" }],
      quality: { run: "half-marathon pace blocks and one VO2 session" }, long_texture: { run: "progression, finishing at half-marathon pace" } },
    { from_week: 12, to_week: 14, template: [{ day: 7, sport: "run", kind: "long" }, { day: 3, sport: "run", kind: "quality" }, { day: 1, sport: "run", kind: "easy" }, { day: 5, sport: "run", kind: "easy" }],
      quality: { run: "short race-pace reminders" }, long_texture: { run: "easy" } },
  ],
  week_overrides: [{ week: 8, change: "extra_deload", reason: "work trip" }],
};

export type PlanCase = {
  key: string;
  profile: AthleteProfile;
  goal: { type: string; raceDate: string | null; eventDistanceKm: number | null; targetTimeSecs: number | null } | null;
  assessment: boolean;
  blueprint?: unknown;
  startDate?: string | null;
};

export const PLAN_CASES: PlanCase[] = [
  { key: "runner_marathon", profile: RUNNER, goal: { type: "marathon", raceDate: "2027-02-07", eventDistanceKm: null, targetTimeSecs: 11400 }, assessment: false },
  { key: "runner_half_assessment", profile: RUNNER, goal: { type: "half_marathon", raceDate: "2027-01-17", eventDistanceKm: null, targetTimeSecs: 5400 }, assessment: true },
  { key: "runner_fitness", profile: RUNNER, goal: null, assessment: false },
  { key: "runner_half_coach_blueprint", profile: RUNNER, goal: { type: "half_marathon", raceDate: "2027-01-17", eventDistanceKm: null, targetTimeSecs: 5400 }, assessment: false, blueprint: COACH_BLUEPRINT },
  { key: "runner_half_bad_blueprint", profile: RUNNER, goal: { type: "half_marathon", raceDate: "2027-01-17", eventDistanceKm: null, targetTimeSecs: null }, assessment: false, blueprint: { phases: "nonsense" } },
  { key: "runner_ultra", profile: RUNNER, goal: { type: "ultra", raceDate: "2027-04-18", eventDistanceKm: 50, targetTimeSecs: null }, assessment: false },
  { key: "beginner_10k", profile: BEGINNER, goal: { type: "10k", raceDate: "2026-12-13", eventDistanceKm: null, targetTimeSecs: 3300 }, assessment: true },
  { key: "no_history_5k", profile: NO_HISTORY, goal: { type: "5k", raceDate: "2026-12-20", eventDistanceKm: null, targetTimeSecs: null }, assessment: true },
  { key: "masters_injured_half", profile: INJURED_MASTERS, goal: { type: "half_marathon", raceDate: "2027-03-14", eventDistanceKm: null, targetTimeSecs: null }, assessment: false },
  { key: "returning_10k_late_start", profile: RETURNING, goal: { type: "10k", raceDate: "2027-01-31", eventDistanceKm: null, targetTimeSecs: null }, assessment: false, startDate: "2026-10-28" },
];

/** Inputs for the profile-builder parity case (runs come from fixtures.ts). */
export const PROFILE_INPUT = {
  name: "Fixture Athlete",
  birthDate: "1988-04-02",
  sex: "male",
  weightKg: 70,
  experienceLevel: "intermediate",
  maxHr: 190,
  restHr: 50,
  hrZoneMaxPcts: null,
  injuryHistory: ["IT band 2023"],
  concerns: [{ concern_type: "soreness", body_part: "calf", description: "left calf tight after intervals", severity: 3, status: "active", last_mentioned_at: "2026-10-08T18:00:00Z" }],
  painLogs: [{ activity_date: "2026-10-06", pain_areas: ["calf"] }],
  feedback: [{ rpe: 8, fatigue_rating: 3 }, { rpe: 6, fatigue_rating: 2 }, { rpe: 9, fatigue_rating: 4 }],
  preferences: { available_days: 5, preferred_days: [2, 3, 4, 6, 7], long_run_day: 7 },
  races: [
    { race_date: "2026-08-15", event_name: "Ghent 10K", distance_type: "10k", distance_km: 10, finish_time_seconds: 2580, dnf: false, sport: "run" },
    { race_date: "2025-11-02", event_name: "Old half", distance_type: "half_marathon", distance_km: 21.1, finish_time_seconds: 5900, dnf: false, sport: "run" },
  ],
  goal: { goal_type: "half_marathon", race_date: "2027-01-17", goal_time_seconds: 5400, goal_distance_m: null },
};
