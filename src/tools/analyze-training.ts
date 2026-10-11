import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { buildRunLoadModel } from "../engine/load/load-model";
import { computeSnapshot } from "../engine/load/snapshot";
import { Athlete, Runs, Today, addDays, mono, nowMsOf, prepareRuns, result } from "./common";

const Input = z.object({ today: Today, athlete: Athlete.optional(), runs: Runs });

/** Week-on-week reading, in the Vēlox voice. Thresholds from the web app's overallInsight. */
function insight(s: { ctl: number; atl: number; tsb: number; rampPct: number | null; hasData: boolean }): string {
  if (!s.hasData) return "No runs in the window yet, so there is no load picture to read.";
  const trend = s.ctl >= s.atl ? "holding" : "still catching up to the recent load";
  const formPart = s.tsb > 5 ? "you are fresh" : s.tsb >= -15 ? "form is neutral" : "fatigue is running ahead of fitness";
  const rampPart =
    s.rampPct != null && s.rampPct > 30 ? " Load jumped this week, so an easier day would help."
    : s.rampPct != null && s.rampPct < -30 ? " Load eased off this week."
    : "";
  return `Fitness is ${trend} and ${formPart}.${rampPart}`;
}

export function registerAnalyzeTraining(server: McpServer): void {
  server.registerTool(
    "velox_analyze_training",
    {
      title: "Analyze training load",
      description: [
        "Fitness (CTL, 42-day), fatigue (ATL, 7-day), form (TSB), acute:chronic ratio with injury-risk band, ramp rate, monotony and a weekly table, from the athlete's Strava runs.",
        "How to call: fetch the last 16 weeks with Strava list_activities and pass each run's fields, including summary.relative_effort. For runs in the last 10 days, also fetch get_activity_performance and pass average_heartrate. Those heart-rate runs calibrate every other run onto the same scale, so pass at least 3.",
        "Load units are TSS-like: an easy hour is roughly 55-70, a threshold hour roughly 100.",
        "Read it as a coach: ACWR above 1.3 is a caution, above 1.5 is high risk. Form below -15 means fatigue is building. Never present the numbers as a diagnosis.",
      ].join(" "),
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ today, athlete, runs }) => {
      const prep = prepareRuns(runs, athlete, today);
      const nowMs = nowMsOf(today);
      const since16w = addDays(today, -112);
      const recent = prep.features.filter((f) => f.activity_date >= since16w);

      const start = prep.features[0]?.activity_date && prep.features[0].activity_date < since16w
        ? prep.features[0].activity_date
        : since16w;
      const model = buildRunLoadModel({
        runs: prep.features.map((f, i) => ({
          activity_date: f.activity_date, trimp: f.trimp, moving_time_min: f.moving_time_min,
          distance_km: f.distance_km, data_quality_score: f.data_quality_score, rpe: prep.rpe[i],
        })),
        startDate: start,
        endDate: today,
      });
      const snap = computeSnapshot(recent, nowMs);
      const s = model.summary;

      const structured = {
        today,
        fitness: { ctl: s.ctl, atl: s.atl, tsb: s.tsb, form: s.formLabel },
        risk: { acwr: snap.acwr, band: snap.overtraining_risk, ramp_pct: s.rampPct, monotony: s.monotony, strain: s.strain },
        volume: {
          this_week_km: snap.distance_7d_km, last_week_km: snap.prior_7d_km, last_28d_km: snap.distance_28d_km,
          longest_run_28d_km: snap.long_run_km_last_4w, runs_7d: snap.sessions_7d, avg_hr_7d: snap.avg_hr_last_7d,
          load_7d: s.weekLoad7,
        },
        weekly: snap.weekly.map((w) => ({
          week_start: w.week_start, km: w.distance_km, runs: w.sessions, long_run_km: w.long_run_km,
          ctl: w.ctl, atl: w.atl, acwr: w.acwr, easy_pct: w.easy_pct, quality_pct: w.quality_pct,
        })),
        insight: insight(s),
        data: {
          runs_used: prep.features.length, runs_with_hr: prep.withHr, skipped_non_runs: prep.skipped,
          max_hr: prep.hr.maxHr, max_hr_source: prep.hr.maxHrSource, rest_hr: prep.hr.restHr, rest_hr_source: prep.hr.restHrSource,
          window_start: start,
          load_methods: prep.calibration.counts,
          calibration_runs: prep.calibration.calibrationRuns,
        },
      };

      const lines = [
        `Fitness ${mono(s.ctl)}, fatigue ${mono(s.atl)}, form ${mono(s.tsb)} (${s.formLabel}).`,
        `ACWR ${mono(snap.acwr, 2)}, risk ${snap.overtraining_risk}. Ramp ${s.rampPct == null ? "n/a" : `${s.rampPct}%`} vs the 4-week average.`,
        `This week ${mono(snap.distance_7d_km, 1)} km, last week ${mono(snap.prior_7d_km, 1)} km, 28 days ${mono(snap.distance_28d_km, 1)} km. Longest run in 4 weeks ${mono(snap.long_run_km_last_4w, 1)} km.`,
        structured.insight,
        `Based on ${prep.features.length} runs, ${prep.withHr} with heart rate. Max HR ${prep.hr.maxHr} (${prep.hr.maxHrSource}), rest HR ${prep.hr.restHr} (${prep.hr.restHrSource}).`,
      ];
      const c = prep.calibration.counts;
      if (c.pace > 0 && prep.features.length > 0) {
        lines.push(`${c.pace} runs are scored from pace alone. Pass average_heartrate for at least 3 recent runs so the rest can be calibrated.`);
      } else if (c.relative_effort + c.pace_calibrated > 0) {
        lines.push(`Load: ${c.heart_rate} runs from heart rate, ${c.relative_effort} from relative effort and ${c.pace_calibrated} from pace, calibrated to this athlete's heart-rate runs.`);
      }
      if (prep.hr.maxHrSource === "default") lines.push("Max HR is a default. Ask the athlete for a measured value or birth date for truer load.");
      return result(lines.join("\n"), structured);
    },
  );
}
