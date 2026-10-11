/**
 * Golden parity generator. Runs the ORIGINAL Vēlox web-app engine on the shared
 * fixtures and writes its outputs to test/golden/*.json. The port must match
 * these exactly (test/golden-*.test.ts).
 *
 * Usage (from the Vēlox web-app checkout, so its tsconfig paths resolve):
 *   cd /path/to/Velox && npx tsx /path/to/velox-mcp/scripts/golden/generate.ts /path/to/Velox
 *
 * Read-only against the web app: nothing there is modified and no network or
 * database call is made (the Supabase client is stubbed in memory).
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ATHLETES, NOW_MS, TODAY, START, buildRuns } from "../../test/golden/fixtures";
import { computeFeaturesFrom } from "./compute-features";

const VELOX = resolve(process.argv[2] ?? ".");
const OUT = resolve(__dirname, "../../test/golden");
const lib = (p: string) => join(VELOX, "lib", p);

// ── Freeze the clock ────────────────────────────────────────────────────────
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW_MS);
    else super(...(args as [string]));
  }
  static now() { return NOW_MS; }
}
globalThis.Date = FrozenDate as DateConstructor;

function write(name: string, data: unknown) {
  writeFileSync(join(OUT, name), JSON.stringify(data) + "\n");
  console.log(`wrote test/golden/${name}`);
}

function stubSupabase(client: { from: unknown }, rows: unknown[]) {
  const captured: Record<string, unknown>[] = [];
  client.from = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit"]) q[m] = () => q;
    q.single = () => Promise.resolve({ data: null, error: null });
    q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
    q.upsert = (payload: Record<string, unknown>) => { captured.push(payload); return Promise.resolve({ error: null }); };
    return q;
  };
  return captured;
}

async function main() {
  const tl = await import(lib("training-load.ts"));
  const ms = await import(lib("multisport-load.ts"));
  const rp = await import(lib("race-predictor.ts"));
  const rmInputs = await import(lib("race-models/inputs.ts"));
  const rmEnsemble = await import(lib("race-models/ensemble.ts"));
  const rmView = await import(lib("race-models/view.ts"));
  const hz = await import(lib("hr-zones.ts"));
  const gp = await import(lib("goal-paces.ts"));
  const sb = await import(lib("supabase.ts"));
  const dc = await import(lib("dashboard-compute.ts"));
  const computeFeatures = computeFeaturesFrom(VELOX, tl.banisterCoeffs);

  const runs = buildRuns();

  // ── features + load model + snapshot, per athlete ────────────────────────
  const perAthlete: Record<string, unknown> = {};
  for (const ath of ATHLETES) {
    const features = runs.map((r) => computeFeatures(r, ath.maxHr, ath.restHr, ath.sex));
    const runDaily = features.map((f, i) => ({
      activity_date: f.activity_date, trimp: f.trimp, moving_time_min: f.moving_time_min,
      distance_km: f.distance_km, data_quality_score: f.data_quality_score, rpe: runs[i].rpe,
    }));
    const model = ms.buildMultisportModel({ runDaily, crossRows: [], maxHr: ath.maxHr, restHr: ath.restHr, sex: ath.sex, startDate: START, endDate: TODAY });

    const since16w = new Date(Date.now() - 16 * 7 * 86400000).toISOString().split("T")[0];
    const captured = stubSupabase(sb.supabase, features.filter((f) => (f.activity_date as string) >= since16w));
    await dc.computeAndSaveSnapshot(1);
    const snap = captured[0];

    const forPrediction = features.map((f) => ({
      activity_date: f.activity_date, distance_km: f.distance_km, moving_time_min: f.moving_time_min,
      average_pace_sec_per_km: f.average_pace_sec_per_km, avg_hr_pct_max: f.avg_hr_pct_max,
      workout_type: f.workout_type, is_long_run: f.is_long_run, is_quality_run: f.is_quality_run, is_easy_run: f.is_easy_run,
    }));
    const weeklyAvgKm = Math.round(features.filter((f) => (f.activity_date as string) >= "2026-09-13").reduce((s, f) => s + (f.distance_km as number), 0) / 4 * 10) / 10;
    const predictions: Record<string, unknown> = {};
    const ensembles: Record<string, unknown> = {};
    for (const goalType of ["5k", "10k", "half_marathon", "marathon"]) {
      predictions[goalType] = rp.predictRaceTime({
        goalType, activities: forPrediction, ctl: model.summary.ctl, acwr: snap.acwr as number | null,
        weeklyAvgKm, weeksToRace: 12, trainingPhase: "Build", goalTimeSeconds: null,
      });
      ensembles[goalType] = rmEnsemble.computeEnsemble(rmInputs.buildInputs({
        activities: forPrediction, asOf: TODAY, targetKm: rp.raceKmFor(goalType), goalType, trainingPhase: "Build", ctl: model.summary.ctl,
      }));
    }
    const view = rmView.buildPredictionView({
      activities: forPrediction, goalType: "half_marathon", goalLabel: "Half Marathon", raceDate: "2027-01-17",
      planStartDate: "2026-09-01", trainingStartDate: null, today: TODAY, ctl: model.summary.ctl,
    });

    perAthlete[ath.key] = {
      features,
      model: {
        daily: model.daily.map((d: Record<string, number>) => ({ date: d.date, run: d.run, total: d.total, ctl: d.ctl, atl: d.atl, tsb: d.tsb })),
        weekly: model.weekly.map((w: Record<string, number>) => ({ week_start: w.week_start, run: w.run, total: w.total })),
        summary: {
          ctl: model.summary.ctl, atl: model.summary.atl, tsb: model.summary.tsb, formLabel: model.summary.formLabel,
          rampPct: model.summary.rampPct, monotony: model.summary.monotony, strain: model.summary.strain,
          weekLoad7: model.summary.weekLoad7.total, hasData: model.summary.hasData,
        },
      },
      snapshot: {
        has_data: snap.has_data, last_activity_date: snap.last_activity_date, acwr: snap.acwr,
        distance_7d_km: snap.distance_7d_km, prior_7d_km: snap.prior_7d_km, distance_28d_km: snap.distance_28d_km,
        sessions_7d: snap.sessions_7d, avg_hr_last_7d: snap.avg_hr_last_7d, long_run_km_last_4w: snap.long_run_km_last_4w,
        overtraining_risk: snap.overtraining_risk, weekly: snap.weekly_chart_data,
      },
      weeklyAvgKm,
      predictions,
      ensembles,
      view,
    };
  }
  write("athletes.json", perAthlete);

  // ── load primitives ───────────────────────────────────────────────────────
  const trimpGrid: unknown[] = [];
  for (const mins of [30, 60, 95]) for (const hr of [120, 145, 165, 182]) for (const sex of ["male", "female", null]) {
    trimpGrid.push({ mins, hr, sex, max: 190, rest: 50, out: tl.banisterTrimp(mins, hr, 190, 50, sex) });
    trimpGrid.push({ mins, hr, sex, max: null, rest: null, out: tl.banisterTrimp(mins, hr, null, null, sex) });
  }
  const rpeGrid: unknown[] = [];
  for (const hours of [0, 0.5, 1, 1.75]) for (const rpe of [null, 0, 1, 4, 7, 10, 11]) {
    rpeGrid.push({ hours, rpe, base: 27.5, out: tl.rpeLoad(hours, rpe, 27.5) });
    rpeGrid.push({ hours, rpe, base: 42.25, out: tl.rpeLoad(hours, rpe, 42.25) });
  }
  const athlete = { ftp: null, maxHr: 188, restHr: 52, sex: "female" };
  const tssCases = [
    { moving_time_min: 0 }, { moving_time_min: 50, trimp: 61.4 }, { moving_time_min: 50, average_heartrate_bpm: 150 },
    { moving_time_min: 50, rpe: 7 }, { moving_time_min: 50 }, { moving_time_min: 50, trimp: 0, average_heartrate_bpm: 0, rpe: 2 },
  ].map((a) => ({ a, out: tl.activityTss({ ...a, sport: "run" }, athlete) }));
  const planned = [
    { workout_type: "rest" }, { workout_type: "easy", target_distance_km: 10 }, { workout_type: "long_run", target_distance_km: 24 },
    { workout_type: "tempo", target_distance_km: 12, target_pace_zone: "zone4" }, { workout_type: "interval", target_duration_min: 55 },
    { workout_type: "threshold", target_distance_km: 9, target_pace_zone: "zone3" }, { workout_type: "race", target_distance_km: 21.1, target_pace_zone: "race_pace" },
  ].flatMap((s) => [
    { s, ctx: {}, out: tl.estimatePlannedLoad({ ...s, sport: "run" }) },
    { s, ctx: { easyPaceSecPerKm: 330, thresholdPaceSecPerKm: 262 }, out: tl.estimatePlannedLoad({ ...s, sport: "run" }, { easyPaceSecPerKm: 330, thresholdPaceSecPerKm: 262 }) },
  ]);
  write("load.json", { trimpGrid, rpeGrid, tssCases, planned });

  // ── zones and paces ───────────────────────────────────────────────────────
  const zones = {
    z190: hz.computeHRZones(190),
    z182custom: hz.computeHRZones(182, [62, 72, 82, 91, 100]),
    normalise: [[60, 70, 80, 90, 100], [70, 60, 80, 90, 100], [55, 65, 75, 85, 100], "x", [51, 52, 53, 54, 100]].map((i) => ({ i, out: hz.normaliseHRZoneMaxPcts(i) })),
    resolve: [
      [195, null, null], [null, null, 178], [null, "1990-05-01", null], [null, null, 130], [null, null, null],
    ].map((args) => ({ args, out: hz.resolveMaxHR(args[0], args[1], args[2]) })),
  };
  const paces = {
    derive: [[2700, "10k"], [1260, "5k"], [6300, "half_marathon"], [14400, "marathon"], [3600, "improve_fitness"], [30000, "ultra", 60]]
      .map((a) => ({ a, out: gp.derivePacesFromGoal(a[0], a[1], a[2]) })),
    fromRace: [[1200, 5], [2580, 10], [0, 10]].map((a) => ({ a, out: gp.pacesFromRaceTime(a[0], a[1]) })),
    fromEasy: [[330, null], [360, 290]].map((a) => ({ a, out: gp.pacesFromEasyPace(a[0], a[1]) })),
    realism: [2400, 2700, 3000, 3300].map((g) => ({
      g, out: gp.assessGoalRealism({ goalTimeSeconds: g, goalType: "10k", prediction: { predictedSeconds: 2760, rangeLowSeconds: 2650, rangeHighSeconds: 2880, confidence: "medium", confidenceNote: "", primaryDriver: "", limiter: null, methodNote: "" } }),
    })),
    fmt: [245, 299.6, 360, 412].map((s) => ({ s, out: gp.fmtPace(s) })),
  };
  write("zones.json", { zones, paces });

  globalThis.Date = RealDate;
}

main().catch((e) => { console.error(e); process.exit(1); });
