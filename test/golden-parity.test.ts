/**
 * Golden parity: the ported engine must reproduce the Vēlox web app's numbers
 * exactly. test/golden/*.json was produced by running the ORIGINAL web-app code
 * on the same fixtures (scripts/golden/generate.ts). Any difference here means
 * the port changed the coaching.
 */
import { describe, expect, it } from "vitest";
import athletes from "./golden/athletes.json";
import load from "./golden/load.json";
import zones from "./golden/zones.json";
import { ATHLETES, NOW_MS, START, TODAY, buildRuns } from "./golden/fixtures";
import { computeRunFeatures } from "@/src/engine/load/run-features";
import { buildRunLoadModel } from "@/src/engine/load/load-model";
import { computeSnapshot } from "@/src/engine/load/snapshot";
import { activityTss, banisterTrimp, estimatePlannedLoad, rpeLoad } from "@/src/engine/load/training-load";
import { predictRaceTime, raceKmFor, type RacePrediction } from "@/src/engine/predict/race-predictor";
import { buildInputs } from "@/src/engine/predict/race-models/inputs";
import { computeEnsemble } from "@/src/engine/predict/race-models/ensemble";
import { buildPredictionView } from "@/src/engine/predict/race-models/view";
import { computeHRZones, normaliseHRZoneMaxPcts, resolveMaxHR } from "@/src/engine/zones/hr-zones";
import { assessGoalRealism, derivePacesFromGoal, fmtPace, pacesFromEasyPace, pacesFromRaceTime } from "@/src/engine/zones/goal-paces";

/** Normalise like the generator's JSON round trip (undefined dropped, -0 → 0). */
const j = <T>(x: T): T => JSON.parse(JSON.stringify(x));
type Golden = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const runs = buildRuns();

describe.each(ATHLETES)("athlete $key", (ath) => {
  const g = (athletes as Golden)[ath.key];
  const features = runs.map((r) => computeRunFeatures(r, ath.maxHr, ath.restHr, ath.sex));

  it("computes identical per-run features (TRIMP, intensity, classification)", () => {
    // The web app also stored null stream fields and the polyline; those are not ported.
    const expected = g.features.map((f: Golden) => {
      const keep = { ...f };
      for (const k of ["summary_polyline", "speed_per_hr", "first_half_pace_sec_per_km", "second_half_pace_sec_per_km",
        "first_third_pace_sec_per_km", "middle_third_pace_sec_per_km", "final_third_pace_sec_per_km", "hr_drift_pct",
        "aerobic_decoupling_pct", "cadence_variability_cv", "ground_contact_proxy"]) delete keep[k];
      return keep;
    });
    expect(j(features)).toEqual(expected);
  });

  it("computes an identical fitness / fatigue / form model", () => {
    const model = buildRunLoadModel({
      runs: features.map((f, i) => ({
        activity_date: f.activity_date, trimp: f.trimp, moving_time_min: f.moving_time_min,
        distance_km: f.distance_km, data_quality_score: f.data_quality_score, rpe: runs[i].rpe,
      })),
      startDate: START,
      endDate: TODAY,
    });
    expect(j(model.daily)).toEqual(g.model.daily);
    expect(j(model.weekly)).toEqual(g.model.weekly);
    expect(j(model.summary)).toEqual(g.model.summary);
  });

  it("computes an identical snapshot (weekly table, ACWR, risk)", () => {
    const since16w = new Date(NOW_MS - 16 * 7 * 86400000).toISOString().split("T")[0];
    const snap = computeSnapshot(features.filter((f) => f.activity_date >= since16w), NOW_MS);
    expect(j(snap)).toEqual(g.snapshot);
  });

  const forPrediction = features.map((f) => ({
    activity_date: f.activity_date, distance_km: f.distance_km, moving_time_min: f.moving_time_min,
    average_pace_sec_per_km: f.average_pace_sec_per_km, avg_hr_pct_max: f.avg_hr_pct_max,
    workout_type: f.workout_type, is_long_run: f.is_long_run, is_quality_run: f.is_quality_run, is_easy_run: f.is_easy_run,
  }));

  it.each(["5k", "10k", "half_marathon", "marathon"])("predicts %s identically (single model and ensemble)", (goalType) => {
    const pred = predictRaceTime({
      goalType, activities: forPrediction, ctl: g.model.summary.ctl, acwr: g.snapshot.acwr,
      weeklyAvgKm: g.weeklyAvgKm, weeksToRace: 12, trainingPhase: "Build", goalTimeSeconds: null, nowMs: NOW_MS,
    });
    expect(j(pred)).toEqual(g.predictions[goalType]);
    const ens = computeEnsemble(buildInputs({
      activities: forPrediction, asOf: TODAY, targetKm: raceKmFor(goalType)!, goalType, trainingPhase: "Build", ctl: g.model.summary.ctl,
    }));
    expect(j(ens)).toEqual(g.ensembles[goalType]);
  });

  it("builds an identical prediction view and series", () => {
    const view = buildPredictionView({
      activities: forPrediction, goalType: "half_marathon", goalLabel: "Half Marathon", raceDate: "2027-01-17",
      planStartDate: "2026-09-01", trainingStartDate: null, today: TODAY, ctl: g.model.summary.ctl,
    });
    expect(j(view)).toEqual(g.view);
  });
});

describe("load primitives", () => {
  it("matches Banister TRIMP across HR, duration and sex", () => {
    for (const c of (load as Golden).trimpGrid) expect(banisterTrimp(c.mins, c.hr, c.max, c.rest, c.sex)).toBe(c.out);
  });
  it("matches RPE load, including out-of-range RPE", () => {
    for (const c of (load as Golden).rpeGrid) expect(rpeLoad(c.hours, c.rpe, c.base)).toBe(c.out);
  });
  it("matches activity TSS for runs", () => {
    for (const c of (load as Golden).tssCases) expect(activityTss(c.a, { maxHr: 188, restHr: 52, sex: "female" })).toBe(c.out);
  });
  it("matches planned-session load", () => {
    for (const c of (load as Golden).planned) expect(estimatePlannedLoad({ ...c.s, sport: "run" }, c.ctx)).toBe(c.out);
  });
});

describe("zones and paces", () => {
  const z = (zones as Golden).zones;
  const p = (zones as Golden).paces;
  it("matches HR zones and their normalisation", () => {
    expect(j(computeHRZones(190))).toEqual(z.z190);
    expect(j(computeHRZones(182, [62, 72, 82, 91, 100]))).toEqual(z.z182custom);
    for (const c of z.normalise) expect(j(normaliseHRZoneMaxPcts(c.i))).toEqual(c.out);
  });
  it("matches max-HR resolution", () => {
    for (const c of z.resolve) expect(resolveMaxHR(c.args[0], c.args[1], c.args[2], TODAY)).toEqual(c.out);
  });
  it("matches goal paces, realism and formatting", () => {
    for (const c of p.derive) expect(j(derivePacesFromGoal(c.a[0], c.a[1], c.a[2]))).toEqual(c.out);
    for (const c of p.fromRace) expect(j(pacesFromRaceTime(c.a[0], c.a[1]))).toEqual(c.out);
    for (const c of p.fromEasy) expect(j(pacesFromEasyPace(c.a[0], c.a[1]))).toEqual(c.out);
    const prediction: RacePrediction = { predictedSeconds: 2760, rangeLowSeconds: 2650, rangeHighSeconds: 2880, confidence: "medium", confidenceNote: "", primaryDriver: "", limiter: null, methodNote: "" };
    for (const c of p.realism) expect(j(assessGoalRealism({ goalTimeSeconds: c.g, goalType: "10k", prediction }))).toEqual(c.out);
    for (const c of p.fmt) expect(fmtPace(c.s)).toBe(c.out);
  });
});
