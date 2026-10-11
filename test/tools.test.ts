import { describe, expect, it } from "vitest";
import athletes from "./golden/athletes.json";
import { TODAY, buildRuns } from "./golden/fixtures";
import { callTool, rpc } from "./helpers";
import { computeRunFeatures } from "@/src/engine/load/run-features";
import { buildRunLoadModel } from "@/src/engine/load/load-model";

/** The fixture runs in the shape Claude passes from Strava list_activities. */
const stravaRuns = buildRuns().map((r, i) => ({
  id: String(1000 + i), name: r.name, sport_type: "Run", start_local: r.start_local,
  distance: r.distance_m, moving_time: r.moving_time_s, elevation_gain: r.elevation_gain_m,
  avg_speed: r.avg_speed_mps, average_heartrate: r.average_heartrate, workout_type: r.workout_type, rpe: r.rpe,
}));
const male = { max_hr: 190, rest_hr: 50, sex: "male" };
const golden = (athletes as Record<string, any>).male_190_50; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("tool registry", () => {
  it("lists every tool as read-only with an input schema", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["velox_adapt_plan", "velox_analyze_training", "velox_build_plan", "velox_get_sessions", "velox_log_run", "velox_ping", "velox_predict_race", "velox_review_week", "velox_zones_and_paces"]);
    for (const t of body.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).not.toMatch(/—|!/);
    }
  });
});

describe("velox_analyze_training", () => {
  it("returns the web app's numbers when every run has heart rate", async () => {
    // With full HR coverage calibration is a no-op, so the tool must equal the
    // golden-verified engine run on the same features.
    const allHr = stravaRuns.map((r) => ({ ...r, average_heartrate: r.average_heartrate ?? 141 }));
    const body = await callTool("velox_analyze_training", { today: TODAY, athlete: male, runs: allHr });
    const out = body.result.structuredContent;
    const feats = allHr.map((r) => computeRunFeatures({ name: r.name, start_local: r.start_local, distance_m: r.distance, moving_time_s: r.moving_time, elevation_gain_m: r.elevation_gain, avg_speed_mps: r.avg_speed, average_heartrate: r.average_heartrate, workout_type: r.workout_type }, 190, 50, "male"));
    const model = buildRunLoadModel({ runs: feats.map((f, i) => ({ activity_date: f.activity_date, trimp: f.trimp, moving_time_min: f.moving_time_min, distance_km: f.distance_km, data_quality_score: f.data_quality_score, rpe: allHr[i].rpe })), startDate: feats[0].activity_date, endDate: TODAY });
    expect(out.fitness).toEqual({ ctl: model.summary.ctl, atl: model.summary.atl, tsb: model.summary.tsb, form: model.summary.formLabel });
    expect(out.data.load_methods).toEqual({ heart_rate: allHr.length, relative_effort: 0, pace_calibrated: 0, pace: 0 });
  });

  it("calibrates runs without heart rate onto the heart-rate scale", async () => {
    const body = await callTool("velox_analyze_training", { today: TODAY, athlete: male, runs: stravaRuns });
    const out = body.result.structuredContent;
    expect(out.data.load_methods.heart_rate).toBe(golden.features.filter((f: { average_heartrate_bpm: number | null }) => f.average_heartrate_bpm != null).length);
    expect(out.data.load_methods.pace_calibrated).toBeGreaterThan(0);
    // Only the treadmill runs (no distance, no HR) stay on the raw pace proxy.
    expect(out.data.load_methods.pace).toBe(stravaRuns.filter((r) => r.distance === 0 && r.average_heartrate == null).length);
    expect(out.risk.band).not.toBe("high");
    expect(out.volume.last_28d_km).toBe(golden.snapshot.distance_28d_km);
    expect(out.weekly).toHaveLength(golden.snapshot.weekly.length);
    expect(body.result.content[0].text).toMatch(/^Fitness \d+, fatigue \d+, form -?\d+/);
  });

  it("skips non-runs and future-dated activities", async () => {
    const extra = [
      { ...stravaRuns[0], id: "ride", sport_type: "Ride" },
      { ...stravaRuns[0], id: "future", start_local: "2026-12-01T07:00:00" },
    ];
    const body = await callTool("velox_analyze_training", { today: TODAY, athlete: male, runs: [...stravaRuns, ...extra] });
    expect(body.result.structuredContent.data.runs_used).toBe(stravaRuns.length);
    expect(body.result.structuredContent.data.skipped_non_runs).toBe(2);
  });

  it("says so when max HR is only a default", async () => {
    const body = await callTool("velox_analyze_training", { today: TODAY, runs: stravaRuns.slice(-10) });
    expect(body.result.structuredContent.data.max_hr_source).toBe("default");
    expect(body.result.content[0].text).toContain("Max HR is a default");
  });

  it("handles an athlete with no runs", async () => {
    const body = await callTool("velox_analyze_training", { today: TODAY, runs: [] });
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.insight).toMatch(/No runs/);
  });

  it("refuses an oversized payload and a bad date without a stack trace", async () => {
    const tooMany = Array.from({ length: 501 }, () => stravaRuns[0]);
    for (const args of [{ today: TODAY, runs: tooMany }, { today: "11/10/2026", runs: [] }]) {
      const body = await callTool("velox_analyze_training", args);
      const failed = body.error != null || body.result?.isError === true;
      expect(failed).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/at .*\.(ts|js):\d+/);
    }
  });
});

describe("velox_zones_and_paces", () => {
  it("builds zones from max HR and paces from a race", async () => {
    const body = await callTool("velox_zones_and_paces", { today: TODAY, max_hr: 190, race_result: { distance_km: 10, time_s: 2580 } });
    const out = body.result.structuredContent;
    expect(out.max_hr_source).toBe("manual");
    expect(out.hr_zones).toHaveLength(5);
    expect(out.pace_anchor).toBe("race_result");
    expect(out.paces.race).toBe("4:18/km");
    expect(out.paces_s_per_km.easy).toBeGreaterThan(out.paces_s_per_km.threshold);
  });

  it("falls back to the goal, then asks for an anchor", async () => {
    const goal = await callTool("velox_zones_and_paces", { today: TODAY, goal: { goal_type: "half_marathon", goal_time_s: 6300 } });
    expect(goal.result.structuredContent.pace_anchor).toBe("goal");
    expect(goal.result.structuredContent.hr_zones).toBeNull();
    const none = await callTool("velox_zones_and_paces", { today: TODAY });
    expect(none.result.content[0].text).toContain("No pace anchor");
  });
});

describe("velox_predict_race", () => {
  it("predicts a half marathon with a range, a model bank and a goal verdict", async () => {
    const body = await callTool("velox_predict_race", {
      today: TODAY, goal_type: "half_marathon", race_date: "2027-01-17", goal_time_s: 5700, athlete: male, runs: stravaRuns,
    });
    const out = body.result.structuredContent;
    expect(out.prediction.seconds).toBeGreaterThan(4800);
    expect(out.prediction.seconds).toBeLessThan(7200);
    expect(out.model_bank.models_answered).toBeGreaterThanOrEqual(3);
    expect(out.goal_realism.verdict).toBeTruthy();
    expect(out.training_phase).toBe("Build");
    expect(body.result.content[0].text).toContain("Model bank");
  });

  it("matches the web app's model bank for the same history", async () => {
    const body = await callTool("velox_predict_race", { today: TODAY, goal_type: "half_marathon", race_date: "2027-01-17", athlete: male, runs: stravaRuns });
    // The golden view was built with plan start 2026-09-01; the series window differs, the central estimate must not.
    expect(body.result.structuredContent.model_bank.central_seconds).toBe(golden.view.central);
  });
});
