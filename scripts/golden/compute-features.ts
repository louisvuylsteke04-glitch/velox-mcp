/**
 * Shared by the golden generators: loads the web app's module-private
 * computeFeatures and adapts fixture runs to the Strava API shape it expects.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { FixtureRun } from "../../test/golden/fixtures";

/** The Strava API shape the web app's computeFeatures expects. */
export function toStrava(r: FixtureRun) {
  return {
    name: r.name, distance: r.distance_m, moving_time: r.moving_time_s,
    elapsed_time: r.elapsed_time_s ?? r.moving_time_s, total_elevation_gain: r.elevation_gain_m ?? 0,
    start_date_local: r.start_local, start_date: r.start_local + "Z",
    average_heartrate: r.average_heartrate ?? undefined, average_cadence: r.average_cadence ?? undefined,
    average_speed: r.avg_speed_mps ?? undefined, workout_type: r.workout_type ?? undefined,
  };
}

export function computeFeaturesFrom(velox: string, banisterCoeffs: unknown) {
  const src = readFileSync(join(velox, "lib", "strava-sync.ts"), "utf8");
  const slice = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));
  const easyAt = src.indexOf("const EASY_RE");
  const code = [
    src.slice(src.indexOf("const RACE_RE"), src.indexOf("\n", easyAt)),
    slice("function classifyFromName", "/**\n * Detailed derived metrics for a non-run"),
    "return computeFeatures;",
  ].join("\n");
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const fn = new Function("banisterCoeffs", js)(banisterCoeffs) as (a: unknown, maxHr: number, restHr: number, sex: string | null) => Record<string, unknown>;
  return (r: FixtureRun, maxHr: number, restHr: number, sex: string | null) => fn(toStrava(r), maxHr, restHr, sex);
}
