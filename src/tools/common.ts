import { z } from "zod";
import { computeRunFeatures, type RunFeatures } from "../engine/load/run-features";
import { hrSettings, type HrSettings } from "../engine/load/athlete";
import { calibrateLoad, type Calibration } from "../engine/load/calibrate";

/** Hard caps so an oversized payload is refused rather than processed. */
export const MAX_RUNS = 500;

export const Today = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the athlete's local date as YYYY-MM-DD.")
  .describe("Today's date in the athlete's time zone, YYYY-MM-DD. Always pass it; the server has no clock of its own.");

export const Athlete = z
  .object({
    max_hr: z.number().int().min(120).max(230).nullish().describe("Measured maximum heart rate, if the athlete knows it."),
    rest_hr: z.number().int().min(30).max(100).nullish().describe("Resting heart rate, if known."),
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().describe("YYYY-MM-DD. Used for a 220 minus age max-HR estimate when max_hr is unknown."),
    sex: z.enum(["male", "female"]).nullish().describe("Selects the Banister load curve. Leave empty if unknown."),
  })
  .describe("What is known about the athlete's heart rate. Every field is optional.");

const RUN_SPORTS = new Set(["Run", "TrailRun", "VirtualRun"]);

export const Run = z.object({
  id: z.string().max(40).nullish().describe("Strava activity id."),
  name: z.string().max(200).nullish(),
  sport_type: z.string().max(40).nullish().describe("Strava sport_type. Non-running activities are skipped."),
  start_local: z.string().regex(/^\d{4}-\d{2}-\d{2}/).describe("Strava start_local, e.g. 2026-10-10T12:24:30."),
  distance: z.number().min(0).max(400_000).describe("Metres (Strava summary.distance)."),
  moving_time: z.number().min(0).max(172_800).describe("Seconds (Strava summary.moving_time)."),
  elapsed_time: z.number().min(0).max(259_200).nullish(),
  elevation_gain: z.number().min(0).max(20_000).nullish().describe("Metres (Strava summary.elevation_gain)."),
  avg_speed: z.number().min(0).max(15).nullish().describe("m/s (Strava summary.avg_speed)."),
  average_heartrate: z.number().min(40).max(240).nullish().describe("bpm, from get_activity_performance. Fetch it for the last 10 days of runs; it also calibrates the runs without it."),
  relative_effort: z.number().min(0).max(2000).nullish().describe("Strava summary.relative_effort. Pass it for every run: it is heart-rate based and costs no extra call."),
  workout_type: z.number().int().nullish().describe("Strava workout_type if known: 1 race, 3 workout."),
  rpe: z.number().min(1).max(10).nullish().describe("Session RPE 1-10, if the athlete gave one."),
});
export type RunIn = z.infer<typeof Run>;

export const Runs = z
  .array(Run)
  .max(MAX_RUNS)
  .describe(`Runs from Strava list_activities, any order, up to ${MAX_RUNS}. Pass the last 16 weeks for a full picture.`);

export type PreparedRuns = {
  hr: HrSettings;
  features: RunFeatures[];
  rpe: (number | null)[];
  skipped: number;
  withHr: number;
  calibration: Calibration;
};

/** Strava runs → engine features, oldest first. Non-runs are skipped and counted. */
export function prepareRuns(runs: RunIn[], athlete: z.infer<typeof Athlete> | undefined, today: string): PreparedRuns {
  const hr = hrSettings(
    { maxHr: athlete?.max_hr, restHr: athlete?.rest_hr, birthDate: athlete?.birth_date, sex: athlete?.sex },
    today,
  );
  const kept = runs
    .filter((r) => !r.sport_type || RUN_SPORTS.has(r.sport_type))
    .filter((r) => r.start_local.slice(0, 10) <= today)
    .sort((a, b) => a.start_local.localeCompare(b.start_local));
  const raw = kept.map((r) =>
    computeRunFeatures(
      {
        name: r.name, start_local: r.start_local, distance_m: r.distance, moving_time_s: r.moving_time,
        elapsed_time_s: r.elapsed_time, elevation_gain_m: r.elevation_gain, avg_speed_mps: r.avg_speed,
        average_heartrate: r.average_heartrate, workout_type: r.workout_type,
      },
      hr.maxHr, hr.restHr, hr.sex,
    ),
  );
  const { features, calibration } = calibrateLoad(raw, kept.map((r) => r.relative_effort ?? null));
  return {
    hr,
    features,
    calibration,
    rpe: kept.map((r) => r.rpe ?? null),
    skipped: runs.length - kept.length,
    withHr: features.filter((f) => f.average_heartrate_bpm != null).length,
  };
}

/** Midday UTC on `today`: a stable "now" for the engine's day arithmetic. */
export function nowMsOf(today: string): number {
  return Date.parse(`${today}T12:00:00Z`);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const mono = (n: number | null | undefined, digits = 0): string =>
  n == null || !Number.isFinite(n) ? "n/a" : n.toFixed(digits);

export function result<T extends Record<string, unknown>>(text: string, structured: T) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}
